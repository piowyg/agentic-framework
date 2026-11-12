import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { STAGE_CONFIG_KEYS } from '../src/config/schema.js';
import { contractFile, contractText, parseFix, parseImplement, parseWriteTests } from '../src/contracts/index.js';
import { FAKE_SPEC, FAKE_TICKET, fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import type { SessionKind } from '../src/harness/types.js';
import { ArtifactError, parseTasks, validateSpec, validateTicket, type ArtifactError as ArtifactErrorType } from '../src/orchestrator/artifacts.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { buildPrompt } from '../src/orchestrator/prompts.js';
import { HostSandbox } from '../src/sandbox/host.js';
import { FRAMEWORK_SKILLS_DIR, resolveSkill, ruleIds, stageSkill, stageSkills } from '../src/skills/stage.js';
import { committedRepo, tmpDir, write, TEST_CONFIG } from './helpers.js';

const SESSION_KINDS: SessionKind[] = [...STAGE_CONFIG_KEYS];

function problems(action: () => unknown): string[] {
  try {
    action();
    return [];
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    return (error as ArtifactErrorType).problems;
  }
}

describe('output contracts', () => {
  it('the contract text comes from the schema and names what the orchestrator checks', () => {
    const implement = contractText('implement', { outDir: '/out' });
    expect(implement).toContain('Write `/out/implement.json`');
    expect(implement).toContain('"tests_added"');
    expect(implement).toContain('`issue` is required');

    const review = contractText('review-spec', { outDir: '/out', acceptance: ['AC-1', 'AC-2'] });
    expect(review).toContain('exactly one entry for each of: AC-1, AC-2');
    expect(review).toContain('`quote`');

    const spec = contractText('grill-technical', { outDir: '/out' });
    for (const section of ['Decisions', 'Affected repos', 'Contracts', 'Test seams', 'Risks', 'Out of scope', 'External assets']) expect(spec).toContain(`- ${section}`);
    expect(spec).toMatch(/`External assets` lists, .* `sandbox.network.allow`/);
    expect(spec).toMatch(/Optionally `## Slices`: .*prefactor.*does not split the ticket/);
    expect(contractText('grill-business', { outDir: '/out', ticketTemplate: '/context/ticket.md' })).toContain('`/context/ticket.md`');
    // gate summaries in the human's language, details for agents in the artifacts' language
    expect(contractText('grill-business', { outDir: '/out', conversation: 'pl' })).toMatch(/Frontmatter `summary`: .* in `pl`/);
    expect(contractText('breakdown', { outDir: '/out', conversation: 'pl' })).toMatch(/summary: … +# a short title in `pl`/);
    // the PR's first paragraph in the PR's language, asked for only when the gate's summary isn't in it
    expect(contractText('grill-technical', { outDir: '/out', conversation: 'pl', prSummary: 'en' })).toMatch(/Frontmatter `pr_summary`: .* in `en`/);
    expect(contractText('grill-technical', { outDir: '/out', conversation: 'pl' })).not.toContain('pr_summary');
  });

  it('every session kind has a contract', () => {
    for (const kind of SESSION_KINDS) expect(contractText(kind, { outDir: '/out' }), kind).toMatch(/Write `\/out\//);
  });

  it('implement: an issue needs its explanation', () => {
    const report = (fields: object) => JSON.stringify({ contract: 1, summary: 's', tests_added: [], ...fields });
    expect(parseImplement(report({ status: 'done' })).status).toBe('done');
    expect(parseImplement(report({ status: 'test_issue', issue: 'AC-2 test expects 500' })).issue).toMatch(/AC-2/);
    expect(problems(() => parseImplement(report({ status: 'spec_issue' })))).toEqual(['status `spec_issue` without `issue`']);
  });

  it('fix: disputed, escalated and not reproduced findings carry a reason', () => {
    const report = (finding: object) => JSON.stringify({ contract: 1, findings: [{ id: 'S1', ...finding }] });
    expect(parseFix(report({ status: 'fixed' })).findings).toHaveLength(1);
    expect(parseFix(report({ status: 'disputed', disputed_on: 'severity', reason: 'cosmetic' })).findings[0]!.disputed_on).toBe('severity');
    expect(problems(() => parseFix(report({ status: 'disputed', reason: 'no' })))).toEqual(['S1: disputed without `disputed_on` and `reason`']);
    expect(problems(() => parseFix(report({ status: 'not_reproduced' })))).toEqual(['S1: not_reproduced without `reason`']);
    expect(parseFix(report({ status: 'escalated', reason: 'the branch has no feature' })).findings[0]!.status).toBe('escalated');
    expect(problems(() => parseFix(report({ status: 'escalated' })))).toEqual(['S1: escalated without `reason`']);
  });

  it('write-tests: every acceptance criterion of the group has a test', () => {
    const report = JSON.stringify({ contract: 1, tests: [{ path: 'CartTest.java', name: 'AC-1 adds an item', ac: ['AC-1'] }], stubs: [] });
    expect(parseWriteTests(report, ['AC-1']).tests).toHaveLength(1);
    expect(problems(() => parseWriteTests(report, ['AC-1', 'AC-2']))).toEqual(['criteria without tests: AC-2']);
  });

  it('write-tests: a test names its criteria; already met ones belong to the group', () => {
    const report = (extra: object) =>
      JSON.stringify({ contract: 1, tests: [{ path: 'CartTest.java', name: 'ac1_addsItem', ac: ['AC-1'] }, { path: 'CartTest.java', name: 'closes', ac: ['AC-2'] }], stubs: [], ...extra });
    expect(problems(() => parseWriteTests(report({}), ['AC-1', 'AC-2']))).toEqual(['test `closes` lacks AC-2 in its name']);
    expect(problems(() => parseWriteTests(report({ already_met: [{ ac: 'AC-3', evidence: 'Cart.java:4' }] }), ['AC-1', 'AC-2']))).toContain("`already_met` outside the group's criteria: AC-3");
  });
});

describe('spec.md', () => {
  it('requires every section and a non-empty list of known repos', () => {
    expect(validateSpec(FAKE_SPEC).affectedRepos).toEqual(['.']);
    const withoutSeams = FAKE_SPEC.replace('## Test seams\n- POST /cart/items\n', '');
    expect(problems(() => validateSpec(withoutSeams))).toEqual(['missing section `## Test seams`']);
    const emptyRepos = FAKE_SPEC.replace('## Affected repos\n- .\n', '## Affected repos\nNone\n');
    expect(problems(() => validateSpec(emptyRepos))).toEqual(['`## Affected repos`: empty list (one repo = `- .`)']);
    const unknown = FAKE_SPEC.replace('- .\n', '- `billing` — invoices\n');
    expect(
      problems(() =>
        validateSpec(unknown, (name) => {
          throw new Error(`repo \`${name}\` unknown`);
        }),
      ),
    ).toEqual(['`## Affected repos`: repo `billing` unknown']);
  });

  it('headings are matched case-insensitively at levels 2 and 3', () => {
    expect(validateSpec(FAKE_SPEC.replaceAll('## ', '### ').replace('### Risks', '### RISKS')).affectedRepos).toEqual(['.']);
  });
});

describe('tasks.yaml contract', () => {
  const ticket = validateTicket(FAKE_TICKET);
  const tasksYaml = (groups: number, tasksPerGroup = 1, rationale = 'r') =>
    `groups:\n${Array.from({ length: groups }, (_, groupIndex) => {
      const tasks = Array.from({ length: tasksPerGroup }, (_, taskIndex) => `{ id: t${taskIndex}, title: x, tier: standard, acceptance: [AC-1, AC-2] }`);
      return `  - { id: g${groupIndex}, repo: ., rationale: "${rationale}", estimate: { prod: 50, tests: 50 }, tasks: [${tasks.join(', ')}] }`;
    }).join('\n')}\n`;

  it('a group says why it is cut this way and holds at most 7 tasks', () => {
    expect(problems(() => parseTasks(tasksYaml(1, 7), ticket))).toEqual([]);
    expect(problems(() => parseTasks(tasksYaml(1, 8), ticket))).toEqual(['groups[0].tasks: must NOT have more than 7 items']);
    expect(problems(() => parseTasks(tasksYaml(1, 1, ''), ticket))).toEqual(['groups[0].rationale: must NOT have fewer than 1 characters']);
  });

  it('more than 6 groups is a warning for the gate, not an error', () => {
    expect(parseTasks(tasksYaml(6), ticket).warnings).toEqual([]);
    expect(parseTasks(tasksYaml(7), ticket).warnings).toEqual([expect.stringMatching(/^oversized: 7 groups/)]);
  });
});

describe('stage skills', () => {
  const frontmatter = (dir: string) => parse(/^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))![1]!) as Record<string, unknown>;

  it('every session kind has its framework skill, named after its directory', () => {
    for (const kind of SESSION_KINDS) {
      const dir = resolveSkill(stageSkill(kind), tmpDir());
      expect(frontmatter(dir).name, kind).toBe(path.basename(dir));
    }
  });

  it('default practice skills exist and their rule ids are unique', () => {
    const practice = new Set(Object.values(TEST_CONFIG.stages).flatMap((stage) => stage.skills ?? []));
    expect([...practice].sort()).toEqual(['agentic-clean-code', 'agentic-test-quality']);
    const rules = fs.readdirSync(FRAMEWORK_SKILLS_DIR).flatMap((name) => ruleIds(fs.readFileSync(path.join(FRAMEWORK_SKILLS_DIR, name, 'SKILL.md'), 'utf8')));
    expect(rules).toEqual(['AG-CODE-01', 'AG-CODE-02', 'AG-CODE-03', 'AG-TQ-01', 'AG-TQ-02', 'AG-TQ-03', 'AG-TQ-04', 'AG-TQ-05']);
  });

  it('rule ids come from the text: a list item opening with a bold id', () => {
    const standards = ['- **TEST-01 Given/When/Then.** text', '* **ARCH-12** bare id', '- **AG-CODE-07 Framework.** multi-segment id', '- a mention of **TEST-02** mid-sentence', '**AG-CODE-09** outside a list'].join('\n');
    expect(ruleIds(standards)).toEqual(['TEST-01', 'ARCH-12', 'AG-CODE-07']);
  });

  it('a linked repo skill is refused; links inside a skill are left out', () => {
    const repo = tmpDir();
    const skillsDir = path.join(repo, '.agentic', 'skills');
    write(path.join(skillsDir, 'own'), 'SKILL.md', '# own');
    fs.symlinkSync(write(tmpDir(), 'secret', 'x'), path.join(skillsDir, 'own', 'secret'));
    fs.symlinkSync(path.join(skillsDir, 'own'), path.join(skillsDir, 'linked'));
    const target = path.join(tmpDir(), 'staged');
    stageSkills(target, ['repo:own'], repo);
    expect(fs.readdirSync(path.join(target, 'own'))).toEqual(['SKILL.md']);
    expect(() => stageSkills(target, ['repo:linked'], repo)).toThrow(/repo:linked`: symlink not allowed/);
  });

  it('skills describe the process; the output format lives only in the contract', () => {
    for (const kind of SESSION_KINDS) {
      const file = contractFile(kind);
      const text = fs.readFileSync(path.join(resolveSkill(stageSkill(kind), tmpDir()), 'SKILL.md'), 'utf8');
      if (file) expect(text, kind).not.toContain(file);
      expect(text, kind).not.toContain('```json');
    }
  });
});

describe('sessions get their skills, template and context', () => {
  function setup(script: FakeScript = {}, idea?: string) {
    const root = tmpDir();
    const repo = committedRepo(path.join(root, 'repo'));
    const harnesses = fakeRegistry(script);
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo }, idea });
    const run = () =>
      runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    return { repo, workDir, harnesses, run };
  }

  it('the stage skill and practice skills are staged read-only, outside the repo, and named in the prompt', async () => {
    const { repo, workDir, harnesses, run } = setup();
    expect((await run()).status).toBe('done');
    const implement = harnesses.calls().find((call) => call.kind === 'implement')!;
    const skillsDir = path.join(workDir, 'out', 'implement-g1-t1.skills');
    expect(implement.contextFiles).toContain(skillsDir);
    expect(fs.readdirSync(skillsDir).sort()).toEqual(['agentic-clean-code', 'agentic-implement', 'agentic-test-quality']);
    expect(implement.prompt).toContain(`Follow the stage skill: ${path.join(skillsDir, 'agentic-implement', 'SKILL.md')}`);
    expect(implement.prompt).toContain(`- ${path.join(skillsDir, 'agentic-clean-code', 'SKILL.md')}`);
    expect(implement.prompt).toContain('Acceptance criteria in scope: AC-1, AC-2.');
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('grill-business gets the repo ticket template, grill-technical the business notes', async () => {
    const { repo, workDir, harnesses, run } = setup({
      'grill-business': { files: { 'ticket.md': FAKE_TICKET, 'business-notes.md': 'Today minors get 422.' } },
    });
    write(repo, '.agentic/templates/ticket.md', '# team template\n');
    expect((await run()).status).toBe('done');
    const grill = harnesses.calls().find((call) => call.kind === 'grill-business')!;
    const staged = path.join(workDir, 'out', 'grill-business.template', 'ticket-template.md');
    expect(grill.contextFiles).toContain(staged);
    expect(fs.readFileSync(staged, 'utf8')).toBe('# team template\n');
    expect(grill.prompt).toContain(`following the ticket template (\`${staged}\`)`);
    expect(grill.prompt).toContain('Talk to the human in `en`');
    const technical = harnesses.calls().find((call) => call.kind === 'grill-technical')!;
    expect(technical.contextFiles).toContain(path.join(workDir, 'business-notes.md'));
    expect(harnesses.calls().find((call) => call.kind === 'breakdown')!.contextFiles).not.toContain(path.join(workDir, 'business-notes.md'));
  });

  it('a pasted idea is read-only context of the business grill only', async () => {
    const { workDir, harnesses, run } = setup({}, 'Guests save the cart for later.\n');
    expect((await run()).status).toBe('done');
    const idea = path.join(workDir, 'idea.md');
    expect(fs.readFileSync(idea, 'utf8')).toBe('Guests save the cart for later.\n');
    expect(harnesses.calls().find((call) => call.kind === 'grill-business')!.contextFiles).toContain(idea);
    expect(harnesses.calls().find((call) => call.kind === 'grill-technical')!.contextFiles).not.toContain(idea);
  });

  it('without a repo template the framework template is used; repo standards are listed', async () => {
    const { repo, harnesses, run } = setup();
    write(repo, '.agentic/standards/testing.md', '# Testing\n');
    expect((await run()).status).toBe('done');
    const grill = harnesses.calls().find((call) => call.kind === 'grill-business')!;
    expect(fs.readFileSync(grill.contextFiles.find((file) => file.endsWith('ticket-template.md'))!, 'utf8')).toContain('## Acceptance criteria');
    expect(grill.prompt).toContain('- .agentic/standards/testing.md');
  });

  it('a grill rerun after the ticket exists mounts the ticket and the template side by side (host sandbox)', async () => {
    const root = tmpDir();
    const repo = committedRepo(path.join(root, 'repo'));
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
    write(workDir, 'ticket.md', FAKE_TICKET);
    const harnesses = fakeRegistry();
    const sandbox = new HostSandbox();
    const views: string[][] = [];
    const recording = { ...harnesses.sandbox, view: (workspace: Parameters<HostSandbox['view']>[0]) => (views.push(sandbox.view(workspace).readOnlyMounts), harnesses.sandbox.view(workspace)) };
    const gates = new ScriptedGates({ ticket: [{ action: 'stop' }] });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: recording, gates });
    expect(views[0]!.map((file) => path.basename(file))).toEqual(['ticket.md', 'ticket-template.md', 'grill-business.skills']);
  });

  it('a test issue from the implementer pauses the group with its reason', async () => {
    const { run } = setup({ implement: { report: { status: 'test_issue', summary: 's', issue: 'AC-2 test expects 500', tests_added: [] } } });
    expect((await run()).paused).toMatchObject({ reason: 'test_issue', group: 'g1', message: 'AC-2 test expects 500' });
  });

  it('a session that keeps writing no report pauses with a clear message', async () => {
    const { run } = setup({ implement: { files: {}, report: undefined } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'checks_failing', group: 'g1' });
    expect(state.paused?.message).toMatch(/Your report `implement\.json` is missing/);
  });

  it('a repo outside the spec’s Affected repos is caught at breakdown; the origin name equals `.`', async () => {
    const plan = (repo: string) =>
      `groups:\n  - { id: g1, repo: ${repo}, rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }\n`;
    const run = async (repo: string) => {
      const root = tmpDir();
      const origin = committedRepo(path.join(root, 'services', 'orders'));
      committedRepo(path.join(root, 'services', 'billing'));
      const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': plan(repo) } } });
      const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: origin, workspaceRoot: root } });
      return runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    };
    expect((await run('billing')).paused?.message).toMatch(/g1: repo `billing` is not in `## Affected repos`/);
    expect((await run('orders')).status).toBe('done');
  });
});

describe('breakdown: estimates and the chain', () => {
  const plan = (groups: string[]) => `groups:\n${groups.map((group) => `  - { id: ${group}, repo: ., rationale: r, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }`).join('\n')}\n`;
  const run = async (tasks: string, config = TEST_CONFIG) => {
    const root = tmpDir();
    const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': tasks } } });
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
    const state = await runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    return Object.assign(state, { breakdownPrompt: harnesses.calls().find((call) => call.kind === 'breakdown')!.prompt });
  };

  it('the breakdown session is told the thresholds of the config', async () => {
    const config = { ...TEST_CONFIG, publish: { ...TEST_CONFIG.publish, size: { ...TEST_CONFIG.publish.size, max_prod_lines: 250 } } };
    expect((await run(plan(['g1']), config)).breakdownPrompt).toContain('over 250 production lines or 800 with tests');
  });

  it('a plan without estimates, or with two first groups in one repo, goes back to the breakdown before the gate', async () => {
    expect((await run(plan(['g1']))).paused?.message).toMatch(/g1: no `estimate`/);
    const parallel = plan(['g1', 'g2']).replaceAll('rationale: r,', 'rationale: r, estimate: { prod: 10, tests: 10 },');
    expect((await run(parallel)).paused?.message).toMatch(/repo `\.`: groups without a predecessor from this repo: g1, g2/);
    expect((await run(parallel, { ...TEST_CONFIG, publish: { ...TEST_CONFIG.publish, stack: false } })).status).toBe('done');
  });

  it('a human who breaks the chain at the gate gets the plan approved, with a warning', async () => {
    const root = tmpDir();
    const estimated = (groups: string[]) => plan(groups).replaceAll('rationale: r,', 'rationale: r, estimate: { prod: 10, tests: 10 },');
    const chained = estimated(['g1', 'g2']).replace('{ id: g2, repo: ., rationale: r,', '{ id: g2, repo: ., depends_on: [g1], rationale: r,');
    const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': chained } } });
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
    const gates = new ScriptedGates();
    const decide = gates.decide.bind(gates);
    gates.decide = async (request) => {
      if (request.gate === 'breakdown') fs.writeFileSync(path.join(workDir, 'tasks.yaml'), estimated(['g1', 'g2']));
      return decide(request);
    };
    const log: string[] = [];

    const state = await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, log: (line) => log.push(line) });

    expect(state.status).toBe('done');
    expect(log).toContain('⚠ plan approved despite: repo `.`: groups without a predecessor from this repo: g1, g2 — the groups of one repo form a chain, each on the previous one (`publish.stack`)');
  });

  it('the contract asks for estimates against the configured thresholds, and for the chain only with a stack', () => {
    const text = contractText('breakdown', { outDir: '/out', size: { prod: 300, total: 600 }, stack: true });
    expect(text).toContain('estimate: { prod: 0, tests: 0 }');
    expect(text).toMatch(/`oversize_reason`.*300 production lines or 600 with tests/);
    expect(text).toMatch(/groups of one repo form a chain/);
    expect(contractText('breakdown', { outDir: '/out', size: { prod: 300, total: 600 }, stack: false })).not.toMatch(/form a chain/);
  });
});

describe('prompt', () => {
  const base = {
    title: 'Koszyk',
    outDir: '/out',
    contextFiles: ['/context/ticket.md'],
    skills: ['/skills/agentic-implement/SKILL.md'],
    standards: [],
    language: { artifacts: 'en', conversation: 'pl' },
  };

  it('inactive rules are named so the agent neither applies nor cites them', () => {
    expect(buildPrompt('review-standards', { ...base, mode: 'headless', inactiveRules: ['AG-CODE-03 (rules.disabled)'] })).toContain('do not cite them in findings');
    expect(buildPrompt('implement', { ...base, mode: 'headless' })).not.toContain('switched off');
  });

  it('headless sessions are told nobody is watching; interactive ones get the conversation language', () => {
    expect(buildPrompt('implement', { ...base, mode: 'headless' })).toContain('Nobody is watching this session');
    const interactive = buildPrompt('grill-business', { ...base, mode: 'interactive', doneFile: '/out/.done' });
    expect(interactive).toContain('Talk to the human in `pl`; write artifacts in `en`.');
    // the agent can't quit an interactive harness itself: it leaves a marker and the orchestrator closes the session
    expect(interactive).toContain('has confirmed it, create the empty file `/out/.done`');
    expect(interactive).not.toContain("The human's machine sees");
    // in a container the agent names its files to the human by their host path (acceptance smoke, finding 2)
    const sandboxed = buildPrompt('grill-business', { ...base, mode: 'interactive', doneFile: '/out/.done', outDir: '/out', hostOutDir: '/home/me/flow/out/grill-business' });
    expect(sandboxed).toContain("The human's machine sees your output directory `/out` as `/home/me/flow/out/grill-business`: name files in it to them by that path.");
  });

  it('interactive sessions read the code without prompts and ask the human about related tickets', () => {
    const interactive = buildPrompt('grill-technical', { ...base, mode: 'interactive', doneFile: '/out/.done' });
    expect(interactive).toContain('search with plain read-only shell commands');
    expect(interactive).toContain('for related tickets or issues, ask the human');
    expect(buildPrompt('implement', { ...base, mode: 'headless' })).not.toContain('issue tracker');
  });
});

describe('host sandbox', () => {
  it('copies a context directory (the staged skills) next to out/', async () => {
    const root = tmpDir();
    const skills = path.join(root, 'flow', 'out', 's.skills');
    write(skills, 'agentic-implement/SKILL.md', 'steps');
    const outDir = path.join(root, 'flow', 'out', 's');
    fs.mkdirSync(outDir, { recursive: true });
    const workspace = { codeDir: root, outDir, readOnlyMounts: [skills], network: [] };
    const sandbox = new HostSandbox();
    const [copy] = sandbox.view(workspace).readOnlyMounts;
    await sandbox.exec({ argv: ['true'] }, workspace, { interactive: false });
    expect(fs.readFileSync(path.join(copy!, 'agentic-implement', 'SKILL.md'), 'utf8')).toBe('steps');
  });
});
