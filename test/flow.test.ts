import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig } from '../src/config/types.js';
import { FAKE_SPEC, FAKE_TICKET, fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow, unfinishedFlows, unfinishedPicks } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { loadState, openFindings, reviewSummary, roundNumber, saveState } from '../src/orchestrator/state.js';
import { summarizeUsage } from '../src/orchestrator/usage.js';
import { committedRepo, tmpDir, write, TEST_CONFIG, QUOTED } from './helpers.js';

function setup(options: { config?: Partial<AgenticConfig> | Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {});
  const { workDir, slug } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  return { root, workDir, slug, harnesses, gates, run };
}

/** A later round's report: the previous round's B1 is fixed (frozen scope). */
const FIXED = { findings: [], previous: [{ id: 'B1', status: 'fixed' }] };

const blocking = (id = 'B1') => ({
    findings: [{ id, severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-2' } }],
});

describe('flow on the fake harness', () => {
  it('the spec gate names what the change needs from outside the repo; the grill must write the section', async () => {
    const withAssets = FAKE_SPEC.replace('## External assets\nNone\n', '## External assets\n- Noto Sans TTF — the human commits it\n- `pdfjs-dist` from npm\n');
    const { run, gates, root } = setup({ script: { 'grill-technical': { files: { 'spec.md': withAssets } } } });
    await run();
    expect(gates.seen[1]!.view).toMatchObject({ facts: [`repositories: ${path.basename(root)}`, 'external (deliver before implementation): Noto Sans TTF — the human commits it; `pdfjs-dist` from npm'] });
  });

  it('goes through all stages: ticket → spec → breakdown → implement (groups by depends_on) → final review', async () => {
    const { run, harnesses, gates, root, workDir, slug } = setup({ config: { stages: { 'write-tests': { enabled: true } } } });
    const state = await run();

    expect(slug).toBe('cart-limit');
    expect(state.status).toBe('done');
    expect(state.outcome).toBe('ready_to_publish');
    expect(Object.values(state.stages).map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(state.groups.g1).toMatchObject({ status: 'done', tasks: { t1: 'done', t2: 'done' }, });
    expect(reviewSummary(state.groups.g1!)).toBe('rounds 1, open blocking 0, nits 0');

    const calls = harnesses.calls().map((call) => `${call.kind}${call.group ? ':' + call.group : ''}${call.task ? '/' + call.task : ''}`);
    expect(calls).toEqual([
      'grill-business',
      'grill-technical',
      'breakdown',
      'write-tests:g1',
      'implement:g1/t1',
      'implement:g1/t2',
      'review-spec:g1',
      'review-standards:g1',
      'write-tests:g2',
      'implement:g2/t1',
      'review-spec:g2',
      'review-standards:g2',
      'review-final',
    ]);
    // standard preset: ticket, spec, breakdown, final (no group)
    expect(gates.seen.map((gate) => gate.gate)).toEqual(['ticket', 'spec', 'breakdown', 'final']);
    expect(gates.seen[2]!.summary).toContain('t1 [domain] Counting items in the cart AC-1 AC-2');
    // the terminal renders the gates from data, not from the text
    expect(gates.seen[0]!.view).toMatchObject({ kind: 'document', file: path.join(workDir, 'ticket.md'), title: 'Cart limit', facts: ['acceptance criteria: AC-1, AC-2'] });
    expect(gates.seen[1]!.view).toMatchObject({ kind: 'document', file: path.join(workDir, 'spec.md'), title: 'Spec: cart limit', facts: [`repositories: ${path.basename(root)}`] }); // `.` named after the repo
    expect(gates.seen[2]!.view).toMatchObject({ kind: 'breakdown', acceptance: ['AC-1', 'AC-2'], groups: [{ id: 'g1' }, { id: 'g2' }], limits: { prod: 400, total: 800 } });
    expect(gates.seen[2]!.summary).toContain('g1 (., ~50 prod / 50 test)');
    expect(gates.seen[3]!.view).toBeUndefined();
    expect(summarizeUsage(workDir)).toMatchObject({ sessions: 13, tokens: 13 * 1200 });
  });

  it('executor from tiers per task, override from tasks.yaml and interactive stages from stages', async () => {
    const tasks = `groups:
  - id: g1
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: a, tier: domain, acceptance: [AC-1] }
      - { id: t2, title: b, tier: mechanical, acceptance: [AC-2], executor: { model: sonnet } }
`;
    const { run, harnesses } = setup({ script: { breakdown: { files: { 'tasks.yaml': tasks } } } });
    await run();
    const impl = harnesses.calls().filter((call) => call.kind === 'implement').map((call) => call.executor);
    expect(impl).toEqual([
      { harness: 'codex', model: 'sol', effort: 'high' },
      { harness: 'claude', model: 'sonnet', effort: 'low' },
    ]);
    const grill = harnesses.calls().find((call) => call.kind === 'grill-business')!;
    expect(grill.mode).toBe('interactive');
    expect(grill.executor).toEqual({ harness: 'claude', model: 'opus', effort: 'high' });
    expect(harnesses.calls().find((call) => call.kind === 'implement')!.skills).toEqual(['agentic-implement', 'agentic-test-quality', 'agentic-clean-code']);
  });

  it('stage_skill replaces the stage skill and keeps practice skills; review sessions get only their own', async () => {
    const { run, harnesses, root } = setup({ config: { stages: { implement: { stage_skill: 'repo:implement-java', skills: ['agentic-clean-code'] } } } });
    write(root, '.agentic/skills/implement-java/SKILL.md', '---\nname: implement-java\n---\nJava way.\n');
    expect((await run()).status).toBe('done');
    expect(harnesses.calls().find((call) => call.kind === 'implement')!.skills).toEqual(['repo:implement-java', 'agentic-clean-code']);
    expect(harnesses.calls().find((call) => call.kind === 'review-spec')!.skills).toEqual(['agentic-review-spec']);
  });

  it('a skill from a source not supported yet pauses the flow with a clear message', async () => {
    const { run } = setup({ config: { stages: { implement: { skills: ['team:java'] } } } });
    expect((await run()).paused?.message).toMatch(/team:.*not supported yet/);
  });

  it('ticket gate: "push and stop" ends the flow after the ticket', async () => {
    const { run, harnesses } = setup({ gates: { ticket: [{ action: 'push_and_stop' }] } });
    const state = await run();
    expect(state).toMatchObject({ status: 'done', outcome: 'ticket_only' });
    expect(harnesses.calls()).toHaveLength(1);
  });

  it('stop at a gate → pause; resume asks again and continues without repeating stages', async () => {
    const { run, harnesses, workDir } = setup({ gates: { spec: [{ action: 'stop' }] } });
    const paused = await run();
    expect(paused).toMatchObject({ status: 'paused', paused: { reason: 'gate', gate: 'spec' } });
    expect(loadState(workDir).stages.spec.status).toBe('done');

    const done = await run();
    expect(done.status).toBe('done');
    expect(harnesses.calls().filter((call) => call.kind === 'grill-technical')).toHaveLength(1);
  });

  it('retry with a note reruns the stage and the note goes into the prompt', async () => {
    const { run, harnesses } = setup({ gates: { spec: [{ action: 'retry', note: 'dodaj idempotencję' }] } });
    await run();
    const specCalls = harnesses.calls().filter((call) => call.kind === 'grill-technical');
    expect(specCalls).toHaveLength(2);
    expect(specCalls[1]!.prompt).toContain('dodaj idempotencję');
  });

  it('abort ends the flow', async () => {
    const { run } = setup({ gates: { breakdown: [{ action: 'abort' }] } });
    expect((await run()).status).toBe('aborted');
  });

  it('invalid artifact → pause with an error; resume reruns the stage', async () => {
    const { run } = setup({
      script: {
        'grill-business': (_request, call) => ({ files: { 'ticket.md': call === 1 ? '---\nstatus: draft\n---\nbez AC' : FAKE_TICKET } }),
      },
    });
    const paused = await run();
    expect(paused.status).toBe('paused');
    expect(paused.paused?.message).toMatch(/status: ready[\s\S]*AC-1/);
    expect((await run()).status).toBe('done');
  });

  it('a grill that ended without its ticket: resume asks, and continues that conversation or starts over', async () => {
    const leftDone: boolean[] = [];
    const script: FakeScript = {
      'grill-business': (request, call) => {
        if (call > 1) leftDone.push(fs.existsSync(path.join(request.outDir, '.done')));
        const files: Record<string, string> = call === 1 ? { 'ticket.md': '---\nstatus: draft\n---\nbez AC', '.done': '' } : { 'ticket.md': FAKE_TICKET };
        return { files };
      },
    };
    for (const [answer, resumed] of [
      [true, true],
      [false, false],
    ] as const) {
      const { workDir, harnesses } = setup({ script });
      const gates = new ScriptedGates({}, [answer]);
      const run = () => runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
      expect((await run()).status).toBe('paused');
      expect((await run()).status).toBe('done');
      expect(gates.asked).toEqual([expect.stringMatching(/grill-business[\s\S]*Continue that conversation/)]);
      const [first, second] = harnesses.calls().filter((call) => call.kind === 'grill-business');
      expect(second!.resumeSessionId).toBe(resumed ? first!.sessionId : undefined);
      expect(second!.prompt.includes('chose to continue this conversation')).toBe(resumed);
    }
    expect(leftDone).toEqual([false, false]);
  });

  it('a grill left with Ctrl+C before the confirmation pauses as interrupted, not as a broken artifact', async () => {
    const script: FakeScript = { 'grill-business': (_request, call) => (call === 1 ? { left: true } : { files: { 'ticket.md': FAKE_TICKET } }) };
    const { workDir, harnesses } = setup({ script });
    const gates = new ScriptedGates({}, [true]);
    const run = () => runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
    const paused = await run();
    expect(paused).toMatchObject({ status: 'paused', paused: { reason: 'human' } });
    expect(paused.paused?.message).toMatch(/grill-business session closed before approval \(Ctrl\+C/);
    expect(paused.paused?.message).not.toMatch(/Niepoprawny artefakt/);
    expect((await run()).status).toBe('done');
    const [first, second] = harnesses.calls().filter((call) => call.kind === 'grill-business');
    expect(second!.resumeSessionId).toBe(first!.sessionId);
    expect(second!.prompt).toMatch(/ticket\.md:\n {2}- file not created/);
    expect(second!.prompt).not.toContain(path.join(workDir, 'ticket.md'));
  });

  it('crash during a task → resume continues from that task', async () => {
    const { run, harnesses } = setup({
      script: { implement: (request, call) => (request.task === 't2' && call === 2 ? { throws: 'proces zabity' } : { output: 'ok' }) },
    });
    const paused = await run();
    expect(paused).toMatchObject({ status: 'paused', paused: { reason: 'error', message: 'proces zabity' } });
    expect(paused.groups.g1!.tasks).toEqual({ t1: 'done', t2: 'running' });

    expect((await run()).status).toBe('done');
    const impl = harnesses.calls().filter((call) => call.kind === 'implement').map((call) => `${call.group}/${call.task}`);
    expect(impl).toEqual(['g1/t1', 'g1/t2', 'g1/t2', 'g2/t1']);
  });

  it('rate limit → pause with reason rate_limit', async () => {
    const { run } = setup({ script: { breakdown: { rateLimited: true } } });
    expect((await run()).paused).toMatchObject({ reason: 'rate_limit' });
  });

  it('review: blocking → fixer → next round clean', async () => {
    const { run, harnesses } = setup({
      script: { 'review-spec': (request, call) => ({ report: request.group === 'g1' && call === 1 ? blocking() : FIXED }) },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(roundNumber(state.groups.g1!)).toBe(2);
    expect(openFindings(state.groups.g1!)).toHaveLength(0);
    const fix = harnesses.calls().find((call) => call.kind === 'fix')!;
    expect(fix.executor).toEqual({ harness: 'codex', model: 'sol', effort: 'high' }); // class of group g1 = domain
    expect(fix.prompt).toContain('brak walidacji');
  });

  it('review: keeps every round with axis and fingerprint, so a returning finding is recognizable', async () => {
    const { run } = setup({ script: { 'review-standards': (request) => ({ report: request.group === 'g1' ? blocking() : { findings: [] } }) }, gates: { group: [{ action: 'continue' }] } });
    const rounds = (await run()).groups.g1!.review!.rounds;
    expect(rounds.map((record) => record.round)).toEqual([1, 2]);
    expect(rounds.map((record) => record.findings.map((finding) => finding.axis))).toEqual([['standards'], ['standards']]);
    expect(rounds[1]!.findings[0]!.fingerprint).toBe(rounds[0]!.findings[0]!.fingerprint);
  });

  it('review: blocking after max_rounds → human decision (pause), also with a preset without the group gate', async () => {
    const { run, gates } = setup({ script: { 'review-standards': { report: blocking() } }, gates: { group: [{ action: 'stop' }] } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'human', group: 'g1' });
    expect(roundNumber(state.groups.g1!)).toBe(2);
    expect(openFindings(state.groups.g1!)).toHaveLength(1);
    expect(gates.seen.at(-1)!.summary).toMatch(/1 open blocking finding after 2 rounds/);
  });

  it('review: human accepts despite findings → flow continues', async () => {
    const { run } = setup({
      script: { 'review-standards': (request) => ({ report: request.group === 'g1' ? blocking() : { findings: [] } }) },
      gates: { group: [{ action: 'continue' }] },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(roundNumber(state.groups.g1!)).toBe(2);
    expect(openFindings(state.groups.g1!)).toHaveLength(1);
  });

  it('review: retry with a note gives the fixer more rounds with the note in the prompt', async () => {
    const { run, harnesses } = setup({
      script: { 'review-standards': (request, call) => ({ report: request.group === 'g1' && call <= 2 ? blocking() : FIXED }) },
      gates: { group: [{ action: 'retry', note: 'użyj istniejącego walidatora' }] },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(roundNumber(state.groups.g1!)).toBe(3);
    expect(openFindings(state.groups.g1!)).toHaveLength(0);
    const fixes = harnesses.calls().filter((call) => call.kind === 'fix');
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.prompt).toContain('użyj istniejącego walidatora');
  });

  it('on_stop: [fail] → flow fails without asking a human', async () => {
    const { run, gates } = setup({
      config: { review: { ...TEST_CONFIG.review, on_stop: ['fail'] } },
      script: { 'review-standards': { report: blocking() } },
    });
    expect((await run()).status).toBe('failed');
    expect(gates.seen.some((gate) => gate.gate === 'group')).toBe(false);
  });

  it('final review with blocking → human decision', async () => {
    const { run } = setup({ script: { 'review-final': { report: blocking() } }, gates: { final: [{ action: 'stop' }] } });
    expect((await run()).paused).toMatchObject({ reason: 'human', gate: 'final' });
  });

  it('a second process on the same flow is rejected; an orphaned lock is released', async () => {
    const { run, workDir } = setup();
    fs.writeFileSync(path.join(workDir, '.lock'), String(process.pid));
    await expect(run()).rejects.toThrow(/already running/);
    fs.writeFileSync(path.join(workDir, '.lock'), '999999999');
    expect((await run()).status).toBe('done');
    expect(fs.existsSync(path.join(workDir, '.lock'))).toBe(false);
  });

  it('spec_issue from the reviewer stops the flow', async () => {
    const { run } = setup({ script: { 'review-spec': { report: { findings: [], spec_issue: 'AC-2 sprzeczne z AC-1' } } } });
    expect((await run()).paused).toMatchObject({ reason: 'spec_issue', message: 'AC-2 sprzeczne z AC-1' });
  });

  it('autonomy strict also asks at the group gate; autopilot only at breakdown and final', async () => {
    const strict = setup({ config: { autonomy: 'strict' } });
    await strict.run();
    expect(strict.gates.seen.map((gate) => gate.gate + (gate.group ? ':' + gate.group : ''))).toEqual([
      'ticket', 'spec', 'breakdown', 'group:g1', 'group:g2', 'final',
    ]);
    const auto = setup({ config: { autonomy: 'autopilot' } });
    await auto.run();
    expect(auto.gates.seen.map((gate) => gate.gate)).toEqual(['breakdown', 'final']);
  });

  it('a one-way change asks at the final gate even when the preset skips it', async () => {
    const oneWay = setup({ config: { autonomy: 'custom', gates: [], publish: { one_way_paths: ['g2-*.txt'] } } });
    expect((await oneWay.run()).status).toBe('done');
    expect(oneWay.gates.seen.map((gate) => gate.gate)).toEqual(['final']);
    const { summary } = oneWay.gates.seen[0]!;
    expect(summary).toMatch(/^gate final outside the preset\n/);
    // the reason once (acceptance smoke, finding 14)
    expect(summary.split('one-way change (publish.one_way_paths): g2-t1.txt')).toHaveLength(2);
    expect(summary).toContain('⚠ one-way change (publish.one_way_paths): g2-t1.txt');

    const twoWay = setup({ config: { autonomy: 'custom', gates: [], publish: { one_way_paths: ['db/**'] } } });
    await twoWay.run();
    expect(twoWay.gates.seen).toEqual([]);
  });

  it('the final gate of an active preset names the one-way files', async () => {
    const { run, gates } = setup({ config: { publish: { one_way_paths: ['g1-*.txt'] } } });
    await run();
    const final = gates.seen.find((gate) => gate.gate === 'final')!;
    expect(final.summary).toContain('⚠ one-way change (publish.one_way_paths): g1-t1.txt, g1-t2.txt');
    expect(final.summary).not.toContain('poza presetem');
  });

  it('pick: starts from the technical grill with a ready ticket', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry();
    const { workDir, state } = createFlow({ workRoot: root, title: 'SHOP-123', entry: 'pick', origin: { repoRoot: committedRepo(root) }, ticket: FAKE_TICKET });
    expect(state.stage).toBe('spec');
    const done = await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    expect(done.status).toBe('done');
    expect(harnesses.calls()[0]!.kind).toBe('grill-technical');
    expect(fs.readFileSync(path.join(workDir, 'ticket.md'), 'utf8')).toBe(FAKE_TICKET);
  });
});

describe('unfinishedPicks', () => {
  it('finds a paused pick of the same ticket in the same repo, not a finished, other or foreign one', () => {
    const root = tmpDir();
    const origin = { repoRoot: committedRepo(root) };
    const pick = (title: string, status: 'paused' | 'done', from = origin) => {
      const { workDir, state } = createFlow({ workRoot: path.join(root, 'work'), title, entry: 'pick', origin: from, ticket: FAKE_TICKET });
      saveState(workDir, { ...state, status });
      return state.slug;
    };
    const paused = pick('SHOP-123', 'paused');
    pick('SHOP-123', 'done');
    pick('SHOP-456', 'paused');
    pick('SHOP-123', 'paused', { repoRoot: path.join(root, 'other') });
    expect(unfinishedPicks([path.join(root, 'work')], 'SHOP-123', origin).map((state) => state.slug)).toEqual([paused]);
  });

  it('unfinishedFlows: every paused or interrupted flow of this repo, `new` and `pick` alike', () => {
    const root = tmpDir();
    const origin = { repoRoot: committedRepo(root) };
    const flow = (title: string, entry: 'new' | 'pick', status: 'paused' | 'running' | 'done', from = origin) => {
      const { workDir, state } = createFlow({ workRoot: path.join(root, 'work'), title, entry, origin: from, ticket: entry === 'pick' ? FAKE_TICKET : undefined });
      saveState(workDir, { ...state, status });
      return state.slug;
    };
    const idea = flow('Eksport', 'new', 'paused');
    const interrupted = flow('SHOP-1', 'pick', 'running');
    flow('SHOP-2', 'pick', 'done');
    flow('SHOP-3', 'pick', 'paused', { repoRoot: path.join(root, 'other') });
    expect(unfinishedFlows([path.join(root, 'work')], origin).map((state) => state.slug).sort()).toEqual([interrupted, idea].sort());
  });

  it('looks in the legacy root too, and a new slug is free in both', () => {
    const root = tmpDir();
    const origin = { repoRoot: committedRepo(root) };
    const [current, legacy] = [path.join(root, 'work'), path.join(root, '.agentic', 'work')];
    const old = createFlow({ workRoot: legacy, title: 'SHOP-123', entry: 'pick', origin, ticket: FAKE_TICKET });
    saveState(old.workDir, { ...old.state, status: 'paused' });
    const fresh = createFlow({ workRoot: current, otherRoots: [current, legacy], title: 'SHOP-123', entry: 'pick', origin, ticket: FAKE_TICKET });
    expect([old.slug, fresh.slug]).toEqual(['shop-123', 'shop-123-2']);
    expect(path.dirname(fresh.workDir)).toBe(current);
    // the new one never ran: interrupted, newest first
    expect(unfinishedPicks([current, legacy], 'SHOP-123', origin).map((state) => state.slug)).toEqual(['shop-123-2', 'shop-123']);
  });
});
