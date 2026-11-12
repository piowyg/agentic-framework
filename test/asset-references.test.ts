import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { PLAIN, renderGate } from '../src/cli/gate-view.js';
import { contractText } from '../src/contracts/index.js';
import { FAKE_SPEC, FAKE_TICKET, fakeRegistry } from '../src/harness/fake.js';
import { ArtifactError, parseTasks, unreferencedAssets, validateTicket } from '../src/orchestrator/artifacts.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateRequest } from '../src/orchestrator/gates.js';
import { buildPrompt } from '../src/orchestrator/prompts.js';
import { committedRepo, tmpDir, TESTS_FIRST_CONFIG, TEST_CONFIG } from './helpers.js';

const PROTOTYPE = '/assets/cart-prototype.html';

const SPEC = FAKE_SPEC.replace(
  '## External assets\nNone',
  `## External assets\n- \`${PROTOTYPE}\` — layout and behaviour source of the cart screens\n- Font Inter from fonts.example — vendored before implementation`,
);

const TASKS = `groups:
  - id: g1
    repo: .
    title: Limit rule
    rationale: the rule and the endpoint together make the first working slice
    estimate: { prod: 50, tests: 50 }
    references:
      - asset: ${PROTOTYPE}
        parts: "screen Cart (lines 100-180)"
        match: limit message under the item list
    tasks:
      - id: t1
        title: Counting items in the cart
        tier: domain
        acceptance: [AC-1, AC-2]
        references:
          - asset: ${PROTOTYPE}
            parts: "function addItem (lines 300-340)"
            match: the add button disables at the limit
      - id: t2
        title: Endpoint POST /cart/items
        tier: standard
        acceptance: [AC-1]
  - id: g2
    repo: .
    title: Configuration
    rationale: the configuration depends on the endpoint from g1
    estimate: { prod: 50, tests: 50 }
    depends_on: [g1]
    tasks:
      - { id: t1, title: Entry in application.yml, tier: mechanical, acceptance: [AC-1] }
`;

const CART_SCREEN = 'screen Cart (lines 100-180)';
const ADD_ITEM = 'function addItem (lines 300-340)';

function problems(action: () => unknown): string[] {
  try {
    action();
    return [];
  } catch (error) {
    if (error instanceof ArtifactError) return error.problems;
    throw error;
  }
}

async function runWithReferences(tasks = TASKS, config = TESTS_FIRST_CONFIG) {
  const root = tmpDir();
  const harnesses = fakeRegistry({ 'grill-technical': { files: { 'spec.md': SPEC } }, breakdown: { files: { 'tasks.yaml': tasks } } });
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
  const gates = new ScriptedGates();
  const requests: GateRequest[] = [];
  const decide = gates.decide.bind(gates);
  gates.decide = async (request) => {
    requests.push(request);
    return decide(request);
  };
  const state = await runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const prompt = (kind: string, group?: string, task?: string) =>
    harnesses.calls().find((call) => call.kind === kind && (!group || call.group === group) && (!task || call.task === task))?.prompt ?? '';
  return { state, prompt, requests };
}

describe('asset references: the breakdown ties groups to parts of the spec’s external assets', () => {
  const ticket = validateTicket(FAKE_TICKET);

  it('a group and a task may name the parts of an asset they must match', () => {
    const [g1] = parseTasks(TASKS, ticket).groups;
    expect(g1!.references).toEqual([{ asset: PROTOTYPE, parts: CART_SCREEN, match: 'limit message under the item list' }]);
    expect(g1!.tasks[0]!.references).toEqual([{ asset: PROTOTYPE, parts: ADD_ITEM, match: 'the add button disables at the limit' }]);
  });

  it('a reference names the asset, the parts and what must match', () => {
    const withoutMatch = TASKS.replace('        match: limit message under the item list\n', '');
    expect(problems(() => parseTasks(withoutMatch, ticket))).toEqual([expect.stringMatching(/groups\[0\]\.references\[0\].*match/)]);
  });

  it('an external asset no group references is listed for the gate; one referenced by a task counts', () => {
    const groups = parseTasks(TASKS, ticket).groups;
    const assets = [`\`${PROTOTYPE}\` — layout source`, 'Font Inter from fonts.example'];
    expect(unreferencedAssets(groups, assets)).toEqual(['Font Inter from fonts.example']);
    const taskOnly = parseTasks(TASKS.replace(/    references:\n      - asset: .*\n        parts: .*\n        match: .*\n/, ''), ticket).groups;
    expect(taskOnly[0]!.references).toBeUndefined();
    expect(unreferencedAssets(taskOnly, assets)).toEqual(['Font Inter from fonts.example']);
  });

  it('the breakdown contract asks to read the assets in full and record the parts each group covers', () => {
    const text = contractText('breakdown', { outDir: '/out' });
    expect(text).toContain('references:');
    expect(text).toMatch(/External assets/);
    expect(text).toMatch(/in full/);
  });

  it('the gate shows each group’s references', () => {
    const groups = parseTasks(TASKS, ticket).groups;
    const view = renderGate('breakdown', undefined, { kind: 'breakdown', file: '/flow/tasks.yaml', groups, acceptance: ticket.acceptance, warnings: [] }, PLAIN, 120);
    expect(view).toContain(`↳ ${PROTOTYPE}: ${CART_SCREEN}`);
    expect(view).toContain(`↳ ${PROTOTYPE}: ${ADD_ITEM}`);
  });
});

describe('asset references in the flow', () => {
  it('a reference to an asset the spec does not list goes back to the breakdown', async () => {
    const { state } = await runWithReferences(TASKS.replaceAll(PROTOTYPE, '/elsewhere/other.html'), TEST_CONFIG);
    expect(state.paused?.message).toContain('g1: reference `/elsewhere/other.html` is not in `## External assets` of spec.md');
  });

  it('the breakdown gate warns about an external asset no group references', async () => {
    const { requests } = await runWithReferences(TASKS, TEST_CONFIG);
    const breakdown = requests.find((request) => request.gate === 'breakdown')!;
    expect(breakdown.summary).toMatch(/⚠ external asset no group references.*Font Inter/);
    expect(breakdown.summary).not.toMatch(/no group references.*cart-prototype/);
  });

  it('write-tests, implement and the spec review get the parts to read; a task its own and its group’s', async () => {
    const { state, prompt } = await runWithReferences();
    expect(state.status).toBe('done');

    for (const text of [prompt('write-tests', 'g1'), prompt('implement', 'g1', 't1'), prompt('review-spec', 'g1')]) {
      expect(text).toContain('Reference assets');
      expect(text).toContain(`\`${PROTOTYPE}\` — ${CART_SCREEN}. Must match: limit message under the item list`);
    }
    expect(prompt('write-tests', 'g1')).toContain(ADD_ITEM);
    expect(prompt('implement', 'g1', 't1')).toContain(ADD_ITEM);
    expect(prompt('implement', 'g1', 't2')).toContain(CART_SCREEN);
    expect(prompt('implement', 'g1', 't2')).not.toContain(ADD_ITEM);
    expect(prompt('implement', 'g2', 't1')).not.toContain('Reference assets');
    expect(prompt('review-standards', 'g1')).not.toContain('Reference assets');
  });

  it('the final review compares the feature with every group’s references', async () => {
    const { prompt } = await runWithReferences();
    const final = prompt('review-final');
    expect(final).toContain(CART_SCREEN);
    expect(final).toContain(ADD_ITEM);
  });
});

describe('asset references in the prompt', () => {
  const base = {
    title: 'Cart',
    mode: 'headless' as const,
    outDir: '/out',
    contextFiles: ['/context/spec.md'],
    skills: ['/skills/stage/SKILL.md'],
    standards: [],
    language: { artifacts: 'en', conversation: 'en' },
    references: [{ asset: PROTOTYPE, parts: CART_SCREEN, match: 'limit message' }],
  };

  it('sessions that build read the parts before they start; the ticket and spec win a disagreement', () => {
    for (const kind of ['write-tests', 'implement', 'fix'] as const) {
      const text = buildPrompt(kind, base);
      expect(text, kind).toMatch(/read these parts before you start/i);
      expect(text, kind).toMatch(/ticket and the spec win/);
    }
  });

  it('reviewers compare the change with the parts: ignoring a reference is a blocking finding', () => {
    for (const kind of ['review-spec', 'review-final'] as const) {
      expect(buildPrompt(kind, base), kind).toMatch(/ignores its reference.*blocking finding/);
    }
  });

  it('no references, no section', () => {
    expect(buildPrompt('implement', { ...base, references: [] })).not.toContain('Reference assets');
  });
});
