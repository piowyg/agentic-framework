import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import type { ForgeConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { parseMarkdown } from '../src/orchestrator/artifacts.js';
import { readEvents } from '../src/orchestrator/events.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { loadState, saveState, type FlowState } from '../src/orchestrator/state.js';
import { branchVariables, featureType, groupBranches, keepGroupBranches, renderBranch } from '../src/publish/branch.js';
import { prDescription, reviewNotes, type StackPosition } from '../src/publish/description.js';
import { createForge, forgeToken, newPullRequestUrl, type Fetch } from '../src/publish/forge.js';
import { mergeDanger, parseNumstat } from '../src/publish/merge-danger.js';
import { publishFlow, type PublishPlan } from '../src/publish/publish.js';
import { stackLayout } from '../src/publish/stack.js';
import { diffSize } from '../src/publish/size.js';
import { flowTarget } from '../src/publish/target.js';
import { rebaseFeature } from '../src/orchestrator/rebase.js';
import type { FlowContext } from '../src/orchestrator/run.js';
import type { AgenticConfig } from '../src/config/types.js';
import { parseRemote } from '../src/publish/remote.js';
import type { SecretScan } from '../src/publish/secrets.js';
import { committedRepo, NO_STACK_CONFIG, QUOTED, tmpDir, TEST_CONFIG } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();

describe('publish: branch name', () => {
  it('takes feat over fix over the rest, and feat without a conventional subject', () => {
    expect(featureType(['test(g1): red tests', 'fix: off by one', 'feat(admission)!: paging'])).toBe('feat');
    expect(featureType(['test: red tests', 'fix(api): off by one'])).toBe('fix');
    expect(featureType(['refactor: split'])).toBe('refactor');
    expect(featureType(['fake: g1-t1.txt', ''])).toBe('feat');
  });

  it('fills the pattern; an empty ticket takes its separator with it', () => {
    const variables = branchVariables({ subjects: ['feat: x'], trackerKey: '#92', title: 'admission — paginate the Invitation allowlist', slug: '92-3' });
    expect(renderBranch('{type}/{ticket}-{title}', variables)).toBe('feat/92-admission-paginate-the-invitation');
    expect(renderBranch('{type}/{ticket}-{title}', { ...variables, ticket: '' })).toBe('feat/admission-paginate-the-invitation');
    expect(renderBranch('agentic/{slug}', variables)).toBe('agentic/92-3');
    expect(branchVariables({ subjects: [], trackerKey: 'BLAB-140', title: 'x', slug: 's' }).ticket).toBe('BLAB-140');
  });

  it('refuses a variable it does not know', () => {
    expect(() => renderBranch('{kind}/{title}', branchVariables({ subjects: [], title: 'x', slug: 's' }))).toThrow(/unknown variables \{kind\}/);
  });

  const ticket = branchVariables({ subjects: ['feat: x'], trackerKey: '#92', title: 'Paginate the invitation list', slug: '92-3' });

  it('one PR of the whole flow: {group} is the ticket title', () => {
    expect(renderBranch('{type}/{ticket}-{group}', ticket)).toBe('feat/92-paginate-the-invitation-list');
  });

  it('a branch per group: {group} is the group title as a slug', () => {
    expect(groupBranches('{type}/{ticket}-{group}', ticket, ['Prefactor: pagination seam', 'Paginate invitations'])).toEqual([
      'feat/92-prefactor-pagination-seam',
      'feat/92-paginate-invitations',
    ]);
  });

  it('a pattern without {group} numbers the groups; a single group keeps the plain name', () => {
    expect(groupBranches('{type}/{ticket}-{title}', ticket, ['Prefactor', 'Paging'])).toEqual(['feat/92-paginate-the-invitation-list-1', 'feat/92-paginate-the-invitation-list-2']);
    expect(groupBranches('{type}/{ticket}-{title}', ticket, ['Paging'])).toEqual(['feat/92-paginate-the-invitation-list']);
  });

  it('two groups whose titles slug alike still get two branches', () => {
    expect(groupBranches('{type}/{group}', ticket, ['Paging', 'paging!'])).toEqual(['feat/paging', 'feat/paging-2']);
  });

  it('a suffix that another group already holds is skipped, so no two groups share a branch', () => {
    expect(groupBranches('{type}/{group}', ticket, ['Paging', 'Paging 2', 'paging'])).toEqual(['feat/paging', 'feat/paging-2', 'feat/paging-3']);
  });
});

describe('publish: remote', () => {
  it('reads host and repo path from scp, ssh and https URLs', () => {
    expect(parseRemote('git@github.com:acme/shop.git')).toEqual({ host: 'github.com', path: 'acme/shop' });
    expect(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toEqual({ host: 'gitlab.example.com', path: 'group/sub/repo' });
    expect(parseRemote('https://github.com/acme/shop')).toEqual({ host: 'github.com', path: 'acme/shop' });
    expect(parseRemote('/tmp/remote.git')).toBeUndefined();
  });
});

describe('publish: merge danger', () => {
  it('a migration or a contract makes the door one-way; areas by lines changed', () => {
    const files = parseNumstat(
      ['10\t0\tbackend/src/main/resources/db/migration/V8__index.sql', '200\t20\tfrontend/src/App.tsx', '-\t-\tdocs/diagram.png', '3\t1\t', 'api/old.proto', 'api/new.proto', ''].join('\0'),
    );
    expect(files.map((file) => file.path)).toEqual(['backend/src/main/resources/db/migration/V8__index.sql', 'frontend/src/App.tsx', 'docs/diagram.png', 'api/new.proto']);
    const danger = mergeDanger(files, ['**/db/migration/**', '**/*.proto']);
    expect(danger).toMatchObject({ door: 'one-way', areas: ['frontend', 'backend', 'api', 'docs'], files: 4, added: 213, deleted: 21 });
    expect(danger.oneWay).toEqual([
      { path: 'backend/src/main/resources/db/migration/V8__index.sql', pattern: '**/db/migration/**' },
      { path: 'api/new.proto', pattern: '**/*.proto' },
    ]);
    expect(mergeDanger([{ path: 'README.md', added: 1, deleted: 0 }], ['**/*.proto'])).toMatchObject({ door: 'two-way', areas: ['.'] });
  });
});

describe('publish: description', () => {
  const finding = { severity: 'nit' as const, message: 'name\n  could be clearer', ...QUOTED, fingerprint: 'f' };
  const state = {
    slug: '92-3',
    groups: {
      g1: {
        status: 'done',
        tasks: {},
        review: { rounds: [{ round: 1, finished_at: '', findings: [{ id: 'F1', ...finding }, { id: 'F2', ...finding, verdict: { status: 'rejected' } }] }] },
        set_aside: [{ kind: 'disputed', finding: { id: 'B1', ...finding, severity: 'blocking', message: 'race' }, reason: 'single writer', fixRound: 1 }],
      },
    },
    final_review: { accepted: [{ id: 'F3', reason: 'follow-up ticket' }] },
  } as unknown as FlowState;

  it('an issue of the repo is closed by the merge; a tracker key from elsewhere is only named', () => {
    const body = (trackerKey: string) => prDescription({ state, language: 'en', ticket: { title: 'paging', trackerKey }, danger: mergeDanger([], []), size: diffSize([], TEST_CONFIG.publish.size), framework: '0.1.0' });
    expect(body('#5')).toMatch(/^Closes #5\n/);
    expect(body('SHOP-12')).toMatch(/^Ticket: SHOP-12\n/);
  });

  it('lists nits, set-aside and accepted findings; rejected ones stay out', () => {
    expect(reviewNotes(state)).toEqual([
      { scope: 'g1', text: '`src/Cart.java:2` name could be clearer' },
      { scope: 'g1', text: '`src/Cart.java:2` race — disputed by the fixer: single writer' },
      { scope: 'final review', text: 'F3 accepted by a human: follow-up ticket' },
    ]);
  });

  it('one PR (`--single`): no notes on final review fixes moved into or withdrawn from group PRs', () => {
    const split = { ...state, final_review: { split: { done: true, moved: { g1: ['a.txt:3'] }, withdrawn: { g2: 'g2' } } }, groups: { ...state.groups, g2: { status: 'done', tasks: {} } } } as unknown as FlowState;
    const body = prDescription({ state: split, language: 'en', ticket: { title: 'paging' }, danger: mergeDanger([], []), size: diffSize([], TEST_CONFIG.publish.size), framework: '0.1.0' });
    expect(body).not.toMatch(/final review's fixes/);
  });

  it('summary, risks, merge danger and the hidden metadata block', () => {
    const body = prDescription({
      state,
      language: 'en',
      ticket: { title: 'paging', trackerKey: '#92' },
      specText: '---\nstatus: ready\nsummary: "Stronicowanie keyset."\n---\n# x\n\n## Risks\n\n- Reviews still clamp size.\n\n## Out of scope\n\nNone\n',
      danger: mergeDanger([{ path: 'db/migration/V8__x.sql', added: 4, deleted: 0 }], ['**/db/migration/**']),
      size: diffSize([{ path: 'db/migration/V8__x.sql', added: 4, deleted: 0 }, { path: 'src/a.test.ts', added: 9, deleted: 1 }, { path: 'package-lock.json', added: 50, deleted: 0 }], TEST_CONFIG.publish.size),
      framework: '0.1.0',
      profile: 'private',
    });
    expect(body).toContain('**Size:** 4 production / 10 tests lines, 50 excluded (lockfiles, generated)');
    expect(body).not.toContain('over the soft limit');
    expect(body).toMatch(/^Stronicowanie keyset\.\n\nCloses #92\n/);
    expect(body).toContain('### Risks (from the spec)\n\n- Reviews still clamp size.\n');
    expect(body).not.toContain('Out of scope');
    expect(body).toContain('**Door:** one-way');
    expect(body).toContain('- `db/migration/V8__x.sql` (`**/db/migration/**`)');
    expect(body).toContain('<!-- agentic {"slug":"92-3","framework":"0.1.0","profile":"private"} -->');
  });

  it('a stack PR: the list of PRs, the group goal and its own notes; summary and risks only in the lowest, the issue closed by the top one', () => {
    const pulls = [
      { title: 'Rule', branch: 'feat/92-1', url: 'https://github.com/acme/shop/pull/7' },
      { title: 'Endpoint', branch: 'feat/92-2' },
    ];
    const body = (index: number, group: string) =>
      prDescription({
        state,
        language: 'en',
        ticket: { title: 'paging', trackerKey: '#92' },
        specText: '---\nstatus: ready\npr_summary: "Stronicowanie keyset."\n---\n# x\n\n## Risks\n\n- Reviews still clamp size.\n',
        danger: mergeDanger([], []),
        size: diffSize([], TEST_CONFIG.publish.size),
        framework: '0.1.0',
        stack: { index, group, notesOf: [group], ...(index === 0 && { goal: 'the age rule' }), pulls },
      });
    const lowest = body(0, 'g1');
    expect(lowest).toMatch(/^Stronicowanie keyset\.\n\nPart of #92\n\n## Stack: PR 1\/2\n\nMerge in this order; [^\n]+\n\n1\. \*\*Rule\*\* ← this PR\n2\. Endpoint \(`feat\/92-2`\)\n\n\*\*Goal:\*\* the age rule\n/);
    expect(lowest).toContain('### Risks (from the spec)');
    expect(lowest).toContain('- **g1:** `src/Cart.java:2` name could be clearer');
    expect(lowest).not.toContain('final review');
    expect(lowest).toContain('<!-- agentic {"slug":"92-3","group":"g1","framework":"0.1.0"} -->');

    const top = body(1, 'g2');
    expect(top).toMatch(/^Closes #92\n\n## Stack: PR 2\/2\n\n[^\n]+\n\n1\. \[Rule\]\(https:\/\/github\.com\/acme\/shop\/pull\/7\)\n2\. \*\*Endpoint\*\* ← this PR\n/);
    expect(top).not.toContain('Stronicowanie');
    expect(top).not.toContain('Risks');
    expect(top).not.toContain('**g1:**');
    expect(top).toContain('- **final review:** F3 accepted by a human: follow-up ticket');
  });

  const stackBody = (stack: Partial<StackPosition>) =>
    prDescription({
      state,
      language: 'en',
      ticket: { title: 'paging' },
      danger: mergeDanger([], []),
      size: diffSize([], TEST_CONFIG.publish.size),
      framework: '0.1.0',
      stack: { index: 1, group: 'g2', notesOf: ['g2'], pulls: [{ title: 'Rule', branch: 'feat/92-1' }, { title: 'Endpoint', branch: 'feat/92-2' }], ...stack },
    });

  it('a stack PR carries the notes of a group under it that got no PR of its own', () => {
    expect(stackBody({ notesOf: ['g1', 'g2'] })).toContain('- **g1:** `src/Cart.java:2` name could be clearer');
  });

  it('a stack PR whose group outgrew the plan says so in its size, with the estimate when the plan had one', () => {
    expect(stackBody({})).toMatch(/^\*\*Size:\*\* 0 production \/ 0 tests lines, 0 excluded \(lockfiles, generated\)$/m);
    expect(stackBody({ missedEstimate: { estimate: { prod: 50, tests: 40 } } })).toMatch(/^\*\*Size:\*\* .* — more than the plan's estimate of ~50 production \/ 40 tests$/m);
    expect(stackBody({ missedEstimate: {} })).toMatch(/^\*\*Size:\*\* .* — the plan had no estimate$/m);
  });

  it('the pr_summary before the gate summary; the template in the PR language, spec and review text as written', () => {
    const body = prDescription({
      state,
      language: 'pl',
      ticket: { title: 'paging' },
      specText: '---\nstatus: ready\nsummary: "For the gate."\npr_summary: "Stronicowanie keyset."\n---\n# x\n\n## Risks\n\n- Reviews still clamp size.\n',
      danger: mergeDanger([{ path: 'a/b.ts', added: 1, deleted: 0 }, { path: 'a/c.ts', added: 1, deleted: 0 }], []),
      size: diffSize([{ path: 'a/b.ts', added: 450, deleted: 0 }, { path: 'a/b.test.ts', added: 400, deleted: 0 }], TEST_CONFIG.publish.size),
      framework: '0.1.0',
    });
    expect(body).toContain('**Rozmiar:** 450 linii produkcyjnych / 400 testów, 0 pominiętych (lockfile’i, generowane) — ponad miękki próg: 400 produkcyjnych, 800 razem z testami');
    expect(body).toMatch(/^Stronicowanie keyset\.\n\n## Na co patrzeć\n\n### Ryzyka \(ze specu\)\n\n- Reviews still clamp size\./);
    expect(body).toContain('- **finalne review:** F3 przyjęte przez człowieka: follow-up ticket');
    expect(body).toContain('**Drzwi:** dwukierunkowe');
    expect(body).toContain('**Zasięg:** 2 pliki w `a`, +2 −0');
    expect(body).not.toContain('For the gate.');
  });
});

/** A fetch that answers from a script and records every request. */
function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const fetcher: Fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const answer = answers.shift() ?? { body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetcher, requests };
}

/** A GitHub that remembers its PRs: an open one is found by its head branch, as the forge looks it up. */
function githubFake() {
  /** How many next draft → ready calls GraphQL refuses, answering 200 with `errors` as GitHub does. */
  const refusals = { ready: 0 };
  const pulls: Array<{ number: number; head: string; base: string; title: string; body: string; draft: boolean }> = [];
  const requests: Array<{ method: string; url: string }> = [];
  const html = (number: number) => `https://github.com/acme/shop/pull/${number}`;
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string | boolean | object>) : {};
    requests.push({ method, url });
    const byHead = /[?&]head=([^&]+)/.exec(url);
    if (method === 'GET' && byHead) {
      const branch = decodeURIComponent(byHead[1]!).split(':')[1];
      return respond(pulls.filter((pull) => pull.head === branch).map((pull) => ({ number: pull.number, node_id: `PR_${pull.number}`, html_url: html(pull.number), draft: pull.draft, base: { ref: pull.base } })));
    }
    if (method === 'POST' && url.endsWith('/graphql')) {
      if (refusals.ready > 0) {
        refusals.ready--;
        return respond({ data: null, errors: [{ message: 'Resource not accessible by integration' }] });
      }
      const id = String((body.variables as unknown as { id: string }).id);
      pulls[Number(id.replace('PR_', '')) - 1]!.draft = false;
      return respond({ data: {} });
    }
    if (method === 'POST' && url.endsWith('/pulls')) {
      const pull = { number: pulls.length + 1, head: String(body.head), base: String(body.base), title: String(body.title), body: String(body.body), draft: body.draft === true };
      pulls.push(pull);
      return respond({ number: pull.number, html_url: html(pull.number) }, 201);
    }
    const patched = /\/pulls\/(\d+)$/.exec(url);
    if (method === 'PATCH' && patched) {
      const pull = pulls[Number(patched[1]) - 1]!;
      Object.assign(pull, { title: body.title, body: body.body }, body.base && { base: body.base });
      return respond({ number: pull.number, html_url: html(pull.number) });
    }
    return respond({});
  };
  return { fetcher, pulls, requests, refusals };
}

const input = { head: 'feat/92-paging', base: 'main', title: '#92 paging', body: 'b', labels: ['agentic'] };

describe('publish: forge', () => {
  it('GitHub: opens a PR and labels it; an open PR of the branch is updated instead', async () => {
    const remote = { host: 'github.com', path: 'acme/shop' };
    const fresh = fakeFetch([{ body: [] }, { status: 201, body: { number: 7, html_url: 'https://github.com/acme/shop/pull/7' } }, { body: [] }]);
    const created = await createForge({ type: 'github' }, remote, 'tok', fresh.fetcher)!.openPullRequest(input);
    expect(created).toEqual({ url: 'https://github.com/acme/shop/pull/7', created: true, warnings: [] });
    expect(fresh.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/shop/pulls?state=open&head=acme%3Afeat%2F92-paging&sort=created&direction=desc',
      'POST https://api.github.com/repos/acme/shop/pulls',
      'POST https://api.github.com/repos/acme/shop/issues/7/labels',
    ]);
    expect(fresh.requests[1]!.body).toEqual({ title: '#92 paging', body: 'b', head: 'feat/92-paging', base: 'main' });
    expect(fresh.requests[0]!.auth).toBe('Bearer tok');

    const open = fakeFetch([{ body: [{ number: 7 }] }, { body: { number: 7, html_url: 'u' } }, { status: 403, body: { message: 'no labels for you' } }]);
    const updated = await createForge({ type: 'github', url: 'https://ghe.acme.com' }, remote, 'tok', open.fetcher)!.openPullRequest(input);
    expect(updated).toMatchObject({ url: 'u', created: false, warnings: [expect.stringContaining('no labels for you')] });
    expect(open.requests[1]).toMatchObject({ method: 'PATCH', url: 'https://ghe.acme.com/api/v3/repos/acme/shop/pulls/7' });
  });

  it('GitLab: a merge request in the project by its encoded path; an error carries the forge message, never the token', async () => {
    const remote = { host: 'gitlab.acme.com', path: 'team/sub/shop' };
    const fresh = fakeFetch([{ body: [] }, { status: 201, body: { iid: 3, web_url: 'https://gitlab.acme.com/team/sub/shop/-/merge_requests/3' } }]);
    expect(await createForge({ type: 'gitlab' }, remote, 'tok', fresh.fetcher)!.openPullRequest(input)).toMatchObject({ created: true, url: expect.stringContaining('/merge_requests/3') });
    expect(fresh.requests[1]).toMatchObject({
      method: 'POST',
      url: 'https://gitlab.acme.com/api/v4/projects/team%2Fsub%2Fshop/merge_requests',
      body: { title: '#92 paging', description: 'b', labels: 'agentic', source_branch: 'feat/92-paging', target_branch: 'main' },
    });

    const refused = fakeFetch([{ status: 401, body: { message: '401 Unauthorized' } }]);
    const error = await createForge({ type: 'gitlab' }, remote, 'secret-token', refused.fetcher)!.openPullRequest(input).catch((caught: Error) => caught);
    expect(String(error)).toMatch(/HTTP 401 "401 Unauthorized"/);
    expect(String(error)).not.toContain('secret-token');
  });

  describe('a stacked PR', () => {
    const github = { host: 'github.com', path: 'acme/shop' };
    const gitlab = { host: 'gitlab.com', path: 'acme/shop' };
    const stacked = { ...input, head: 'feat/92-paging-2', base: 'feat/92-paging-1', draft: true };

    it('GitHub: a new one is a draft on the predecessor branch, looked up by its branch alone', async () => {
      const noOpenPr = fakeFetch([{ body: [] }, { status: 201, body: { number: 8, html_url: 'u8' } }, { body: [] }]);
      await createForge({ type: 'github' }, github, 'tok', noOpenPr.fetcher)!.openPullRequest(stacked);
      expect(noOpenPr.requests[0]!.url).toBe('https://api.github.com/repos/acme/shop/pulls?state=open&head=acme%3Afeat%2F92-paging-2&sort=created&direction=desc');
      expect(noOpenPr.requests[1]!.body).toEqual({ title: '#92 paging', body: 'b', head: 'feat/92-paging-2', base: 'feat/92-paging-1', draft: true });
    });

    it('GitHub: an open PR on another base is updated and moved onto the new one, not opened twice', async () => {
      const openOnMain = fakeFetch([{ body: [{ number: 8, base: { ref: 'main' } }] }, { body: { number: 8, html_url: 'u8' } }, { body: [] }]);
      expect(await createForge({ type: 'github' }, github, 'tok', openOnMain.fetcher)!.openPullRequest(stacked)).toMatchObject({ created: false });
      expect(openOnMain.requests[1]).toMatchObject({ method: 'PATCH', body: { title: '#92 paging', body: 'b', base: 'feat/92-paging-1' } });
    });

    it('GitHub: an open PR already on the base is updated without touching the base', async () => {
      const openOnPredecessor = fakeFetch([{ body: [{ number: 8, base: { ref: 'feat/92-paging-1' } }] }, { body: { number: 8, html_url: 'u8' } }, { body: [] }]);
      await createForge({ type: 'github' }, github, 'tok', openOnPredecessor.fetcher)!.openPullRequest(stacked);
      expect(openOnPredecessor.requests[1]!.body).toEqual({ title: '#92 paging', body: 'b' });
    });

    it('GitLab: a new one is a `Draft:` title on the predecessor branch, looked up by its branch alone', async () => {
      const noOpenMr = fakeFetch([{ body: [] }, { status: 201, body: { iid: 4, web_url: 'u4' } }]);
      await createForge({ type: 'gitlab' }, gitlab, 'tok', noOpenMr.fetcher)!.openPullRequest(stacked);
      expect(noOpenMr.requests[0]!.url).toBe('https://gitlab.com/api/v4/projects/acme%2Fshop/merge_requests?state=opened&source_branch=feat%2F92-paging-2&order_by=created_at&sort=desc');
      expect(noOpenMr.requests[1]!.body).toMatchObject({ title: 'Draft: #92 paging', source_branch: 'feat/92-paging-2', target_branch: 'feat/92-paging-1' });
    });

    it('GitLab: an open draft MR stays a draft and moves onto the new target', async () => {
      const draftOnMain = fakeFetch([{ body: [{ iid: 4, draft: true, target_branch: 'main' }] }, { body: { iid: 4, web_url: 'u4' } }]);
      await createForge({ type: 'gitlab' }, gitlab, 'tok', draftOnMain.fetcher)!.openPullRequest({ ...stacked, draft: false });
      expect(draftOnMain.requests[1]).toMatchObject({ method: 'PUT', body: { title: 'Draft: #92 paging', target_branch: 'feat/92-paging-1' } });
    });

    it('GitLab: the stack\'s second pass, which gives no draft state, keeps an open draft MR a draft', async () => {
      const draftOnPredecessor = fakeFetch([{ body: [{ iid: 4, draft: true, target_branch: 'feat/92-paging-1' }] }, { body: { iid: 4, web_url: 'u4' } }]);
      const { draft, ...linksOnly } = stacked;
      await createForge({ type: 'gitlab' }, gitlab, 'tok', draftOnPredecessor.fetcher)!.openPullRequest(linksOnly);
      expect(draftOnPredecessor.requests[1]!.body).toMatchObject({ title: 'Draft: #92 paging' });
    });

    it('GitLab: an open draft MR reported as `work_in_progress` (GitLab before 13.2) stays a draft', async () => {
      const olderGitLabDraft = fakeFetch([{ body: [{ iid: 4, work_in_progress: true, target_branch: 'feat/92-paging-1' }] }, { body: { iid: 4, web_url: 'u4' } }]);
      await createForge({ type: 'gitlab' }, gitlab, 'tok', olderGitLabDraft.fetcher)!.openPullRequest({ ...stacked, draft: false });
      expect(olderGitLabDraft.requests[1]!.body).toMatchObject({ title: 'Draft: #92 paging' });
    });

    it('GitLab: an open ready MR stays ready and keeps its target', async () => {
      const readyOnPredecessor = fakeFetch([{ body: [{ iid: 4, draft: false, target_branch: 'feat/92-paging-1' }] }, { body: { iid: 4, web_url: 'u4' } }]);
      await createForge({ type: 'gitlab' }, gitlab, 'tok', readyOnPredecessor.fetcher)!.openPullRequest(stacked);
      expect(readyOnPredecessor.requests[1]!.body).toEqual({ title: '#92 paging', description: 'b', labels: 'agentic' });
    });
  });

  describe('draft → ready', () => {
    const github = { host: 'github.com', path: 'acme/shop' };
    const lowest = { ...input, ready: true };
    /** GitHub with one open PR #8 of the branch: the lookup, the update, then whatever comes after. */
    const githubWithOpenPull = (pull: { draft: boolean; node_id?: string }, ...after: Array<{ status?: number; body: unknown }>) =>
      fakeFetch([{ body: [{ number: 8, base: { ref: 'main' }, ...pull }] }, { body: { number: 8, html_url: 'u8' } }, ...after]);
    const openDraft = () => githubWithOpenPull({ draft: true, node_id: 'PR_kw8' }, { body: { data: {} } }, { body: [] });

    it('GitHub: an open draft asked to be ready is updated, then marked ready through GraphQL (REST can\'t)', async () => {
      const draft = openDraft();
      expect(await createForge({ type: 'github' }, github, 'tok', draft.fetcher)!.openPullRequest(lowest)).toEqual({ url: 'u8', created: false, readied: true, warnings: [] });
      expect(draft.requests[2]).toMatchObject({ method: 'POST', url: 'https://api.github.com/graphql', body: { variables: { id: 'PR_kw8' } }, auth: 'Bearer tok' });
      expect(String((draft.requests[2]!.body as { query: string }).query)).toContain('markPullRequestReadyForReview');
    });

    it('GitHub Enterprise: GraphQL lives at /api/graphql of the instance', async () => {
      const draft = openDraft();
      await createForge({ type: 'github', url: 'https://ghe.acme.com' }, github, 'tok', draft.fetcher)!.openPullRequest(lowest);
      expect(draft.requests[2]!.url).toBe('https://ghe.acme.com/api/graphql');
    });

    it('GitHub: GraphQL refusing with 200 and `errors` fails the call instead of reporting the PR ready', async () => {
      const refused = githubWithOpenPull({ draft: true, node_id: 'PR_kw8' }, { body: { data: null, errors: [{ message: 'Resource not accessible by integration' }] } });
      await expect(createForge({ type: 'github' }, github, 'tok', refused.fetcher)!.openPullRequest(lowest)).rejects.toThrow('PR #8 did not leave draft: Resource not accessible by integration; mark it ready for review on GitHub and retry');
    });

    it('GitHub: a draft without node_id fails the call instead of staying a draft quietly', async () => {
      const noNodeId = githubWithOpenPull({ draft: true });
      await expect(createForge({ type: 'github' }, github, 'tok', noNodeId.fetcher)!.openPullRequest(lowest)).rejects.toThrow('PR #8 has no node_id');
    });

    it('GitHub: a PR already ready asked to be ready gets no GraphQL call', async () => {
      const openReady = githubWithOpenPull({ draft: false, node_id: 'PR_kw8' }, { body: [] });
      expect(await createForge({ type: 'github' }, github, 'tok', openReady.fetcher)!.openPullRequest(lowest)).not.toHaveProperty('readied');
      expect(openReady.requests.map((request) => request.url)).not.toContain('https://api.github.com/graphql');
    });

    it('GitHub: a draft not asked to be ready stays a draft, no GraphQL call', async () => {
      const draft = githubWithOpenPull({ draft: true, node_id: 'PR_kw8' }, { body: [] });
      expect(await createForge({ type: 'github' }, github, 'tok', draft.fetcher)!.openPullRequest(input)).not.toHaveProperty('readied');
      expect(draft.requests.map((request) => request.url)).not.toContain('https://api.github.com/graphql');
    });

    it('GitLab: an open draft asked to be ready loses the `Draft:` prefix', async () => {
      const openDraft = fakeFetch([{ body: [{ iid: 4, draft: true, target_branch: 'main' }] }, { body: { iid: 4, web_url: 'u4' } }]);
      expect(await createForge({ type: 'gitlab' }, { host: 'gitlab.com', path: 'acme/shop' }, 'tok', openDraft.fetcher)!.openPullRequest(lowest)).toMatchObject({ readied: true });
      expect(openDraft.requests[1]).toMatchObject({ method: 'PUT', body: { title: '#92 paging' } });
    });
  });

  describe('PR state', () => {
    const github = createForgeWith('github');
    const gitlab = createForgeWith('gitlab');

    function createForgeWith(type: 'github' | 'gitlab') {
      return (answer: unknown) => {
        const fetched = fakeFetch([{ body: answer }]);
        const remote = { host: `${type}.com`, path: 'acme/shop' };
        return { forge: createForge({ type }, remote, 'tok', fetched.fetcher)!, requests: fetched.requests };
      };
    }

    it('GitHub: the newest PR of the branch in any state; merged carries the commit on the base', async () => {
      const { forge, requests } = github([
        { number: 9, html_url: 'u9', state: 'closed', draft: false, merged_at: '2026-11-08T10:00:00Z', merge_commit_sha: 'squash9', base: { ref: 'main' }, head: { sha: 'tip9' } },
        { number: 3, html_url: 'u3', state: 'closed', merged_at: null, base: { ref: 'main' }, head: { sha: 'tip3' } },
      ]);
      expect(await forge.pullRequestState('feat/92-paging')).toEqual({ url: 'u9', status: 'merged', draft: false, base: 'main', head: 'tip9', mergeCommit: 'squash9' });
      expect(requests[0]!.url).toBe('https://api.github.com/repos/acme/shop/pulls?state=all&head=acme%3Afeat%2F92-paging&sort=created&direction=desc');
    });

    it('GitHub: open draft and closed unmerged PRs have no merge commit, though GitHub reports its test merge', async () => {
      expect(await github([{ number: 9, html_url: 'u9', state: 'open', draft: true, merged_at: null, merge_commit_sha: 'test-merge', base: { ref: 'feat/a' }, head: { sha: 't' } }]).forge.pullRequestState('b')).toEqual({
        url: 'u9',
        status: 'open',
        draft: true,
        base: 'feat/a',
        head: 't',
      });
      expect(await github([{ number: 9, html_url: 'u9', state: 'closed', merged_at: null, merge_commit_sha: 'test-merge', base: { ref: 'main' }, head: { sha: 't' } }]).forge.pullRequestState('b')).not.toHaveProperty('mergeCommit');
    });

    it('base or head the forge didn\'t send: absent, not an empty string', async () => {
      expect(await github([{ number: 9, html_url: 'u9', state: 'open', draft: false }]).forge.pullRequestState('b')).toEqual({ url: 'u9', status: 'open', draft: false });
      expect(await gitlab([{ iid: 4, web_url: 'u4', state: 'opened' }]).forge.pullRequestState('b')).toEqual({ url: 'u4', status: 'open', draft: false });
    });

    it('a branch that never had a PR: undefined', async () => {
      expect(await github([]).forge.pullRequestState('b')).toBeUndefined();
      expect(await gitlab([]).forge.pullRequestState('b')).toBeUndefined();
    });

    const mergedRequest = { iid: 4, web_url: 'u4', state: 'merged', draft: false, target_branch: 'main', sha: 'tip4' };

    it('GitLab: the newest merge request of the branch in any state; merged by a merge commit carries it', async () => {
      const { forge, requests } = gitlab([{ ...mergedRequest, merge_commit_sha: 'merge4', squash_commit_sha: 'squash4' }]);
      expect(await forge.pullRequestState('feat/92-paging')).toEqual({ url: 'u4', status: 'merged', draft: false, base: 'main', head: 'tip4', mergeCommit: 'merge4' });
      expect(requests[0]!.url).toBe('https://gitlab.com/api/v4/projects/acme%2Fshop/merge_requests?state=all&source_branch=feat%2F92-paging&order_by=created_at&sort=desc');
    });

    it.each([
      ['a squash fast-forwarded: the squash commit', { squash: true, merge_commit_sha: null, squash_commit_sha: 'squash4' }, 'squash4'],
      ['a plain fast-forward: the head itself', { squash: false, merge_commit_sha: null, squash_commit_sha: null }, 'tip4'],
      ['a fast-forward on a GitLab without squash fields: the head itself', { merge_commit_sha: null }, 'tip4'],
    ])('GitLab: merged by %s', async (_how, merge, mergeCommit) => {
      expect(await gitlab([{ ...mergedRequest, ...merge }]).forge.pullRequestState('b')).toMatchObject({ mergeCommit });
    });

    it('GitLab: a squash whose commit GitLab didn\'t report has no merge commit, not the branch tip', async () => {
      expect(await gitlab([{ ...mergedRequest, squash: true, merge_commit_sha: null }]).forge.pullRequestState('b')).not.toHaveProperty('mergeCommit');
    });

    it.each([
      ['an open draft (the pre-13.2 `work_in_progress`)', { state: 'opened', work_in_progress: true }, { status: 'open', draft: true }],
      ['a locked one, mid-merge, still open', { state: 'locked', draft: false }, { status: 'open', draft: false }],
      ['a closed one', { state: 'closed', draft: false }, { status: 'closed', draft: false }],
    ])('GitLab: %s', async (_what, state, expected) => {
      const request = { iid: 4, web_url: 'u4', target_branch: 'feat/a', sha: 't' };
      expect(await gitlab([{ ...request, ...state }]).forge.pullRequestState('b')).toEqual({ url: 'u4', base: 'feat/a', head: 't', ...expected });
    });
  });

  it('none: a link to open the PR by hand on a known host', () => {
    expect(newPullRequestUrl({ host: 'github.com', path: 'acme/shop' }, { head: 'feat/x-2', base: 'feat/x-1' })).toBe('https://github.com/acme/shop/compare/feat%2Fx-1...feat%2Fx-2?expand=1');
    expect(newPullRequestUrl({ host: 'github.com', path: 'acme/shop' }, { head: 'feat/x', base: 'main' })).toBe('https://github.com/acme/shop/compare/main...feat%2Fx?expand=1');
    expect(newPullRequestUrl({ host: 'gitlab.com', path: 'acme/shop' }, { head: 'feat/x', base: 'main' })).toContain('/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx');
    expect(newPullRequestUrl({ host: 'git.acme.com', path: 'acme/shop' }, { head: 'x', base: 'main' })).toBeUndefined();
  });

  it('a token from an empty variable is an error that names the variable', async () => {
    await expect(forgeToken({ type: 'github', auth: { env: 'NO_SUCH_TOKEN' } }, 'github.com', {})).rejects.toThrow(/`NO_SUCH_TOKEN`.*empty/);
    await expect(forgeToken({ type: 'github', auth: { env: 'T' } }, 'github.com', { T: 'abc' })).resolves.toBe('abc');
  });
});

/** A flow run to `ready_to_publish` on the fake harness, its repo with a bare `origin` behind a GitHub URL. */
async function finishedFlow(script?: FakeScript, config: AgenticConfig = TEST_CONFIG) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry(script);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
  const state = await runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  expect(state.outcome).toBe('ready_to_publish');
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv() });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  git(repo, 'config', 'url.' + bare + '.insteadOf', 'https://github.com/acme/shop.git');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return { root, repo, bare, workDir };
}

function publishOptions(workDir: string, overrides: Partial<Parameters<typeof publishFlow>[0]> = {}) {
  const log: string[] = [];
  const plans: PublishPlan[] = [];
  const github = fakeFetch([{ body: [] }, { status: 201, body: { number: 1, html_url: 'https://github.com/acme/shop/pull/1' } }, { body: [] }]);
  const scan: SecretScan = async () => [];
  const options = {
    workDir,
    config: TEST_CONFIG,
    forge: { type: 'github', auth: { env: 'GH' } } as ForgeConfig,
    framework: '0.1.0',
    confirm: async (plan: PublishPlan) => (plans.push(plan), true),
    log: (message: string) => log.push(message),
    scan,
    fetcher: github.fetcher,
    token: async () => 'tok',
    ...overrides,
  };
  return { options, log, plans, requests: github.requests };
}

describe('agentic publish', () => {
  it('scans, pushes the feature under the branch pattern, opens the PR and cleans the work branches up', async () => {
    const { repo, bare, workDir } = await finishedFlow();
    const finalHead = git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final');
    const scanned: string[] = [];
    const { options, plans, requests, log } = publishOptions(workDir, { single: true, scan: async (_repo, range) => (scanned.push(range), []) });

    const published = await publishFlow(options);

    expect(scanned).toEqual([`refs/remotes/origin/main..${finalHead}`]);
    expect(plans[0]).toMatchObject({ branch: 'feat/cart-limit', base: 'main', head: finalHead, title: 'Cart limit', foreignCommits: 0, forge: 'github' });
    // the fake agents write no tests and no lockfile: every changed line is production, as git's own count says
    const [, insertions, deletions] = git(repo, 'diff', '--shortstat', `refs/remotes/origin/main...${finalHead}`).match(/(\d+) insertions?\(\+\)(?:, (\d+) deletions?)?/) ?? [];
    const changed = Number(insertions) + Number(deletions ?? 0);
    expect(changed).toBeGreaterThan(0);
    expect(plans[0]!.size).toMatchObject({ prod: changed, tests: 0, excluded: 0, over: [] });
    expect((requests[1]!.body as { body: string }).body).toContain(`**Size:** ${changed} production / 0 tests lines, 0 excluded`);
    expect(git(bare, 'rev-parse', 'refs/heads/feat/cart-limit')).toBe(finalHead);
    expect(requests[1]).toMatchObject({ method: 'POST', body: { head: 'feat/cart-limit', base: 'main', title: 'Cart limit' } });
    expect((requests[1]!.body as { body: string }).body).toContain('<!-- agentic {"slug":"cart-limit"');
    expect(fs.readFileSync(path.join(workDir, 'pr.md'), 'utf8')).toBe((requests[1]!.body as { body: string }).body);

    const state = loadState(workDir);
    expect(state).toMatchObject({ outcome: 'published', published: { branch: 'feat/cart-limit', base: 'main', head: finalHead, url: published!.url } });
    expect(readEvents(workDir).at(-1)).toMatchObject({ type: 'flow_published', branch: 'feat/cart-limit', url: 'https://github.com/acme/shop/pull/1' });
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/')).toBe('');
    expect(fs.existsSync(path.join(workDir, 'clones'))).toBe(false);
    expect(log).toContain('PR opened: https://github.com/acme/shop/pull/1');
  });

  it('a secret in the flow commits stops it before the push', async () => {
    const { bare, workDir } = await finishedFlow();
    const { options } = publishOptions(workDir, { scan: async () => [{ rule: 'aws-access-token', file: 'a.txt', line: 1, commit: 'e55d32a60447003d' }] });
    await expect(publishFlow(options)).rejects.toThrow(/1 possible secrets[\s\S]*a\.txt:1 \(aws-access-token, commit e55d32a60447\)/);
    expect(git(bare, 'for-each-ref', 'refs/heads/feat/')).toBe('');
    expect(loadState(workDir).outcome).toBe('ready_to_publish');
  });

  it('declined: nothing leaves the machine and the work branches stay', async () => {
    const { repo, bare, workDir } = await finishedFlow();
    const { options } = publishOptions(workDir, { confirm: async () => false });
    expect(await publishFlow(options)).toBeUndefined();
    expect(git(bare, 'for-each-ref', 'refs/heads/feat/')).toBe('');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/')).not.toBe('');
  });

  it('one PR of the whole flow: {group} in the pattern is the ticket title', async () => {
    const { bare, workDir } = await finishedFlow();
    const config = { ...TEST_CONFIG, git: { ...TEST_CONFIG.git, branch_pattern: '{type}/{group}' } };
    const { options, plans } = publishOptions(workDir, { config, single: true });
    await publishFlow(options);
    expect(plans[0]!.branch).toBe('feat/cart-limit');
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/')).toBe('refs/heads/feat/cart-limit');
  });

  it('--single: the plan says the flow goes out as one PR because of the flag', async () => {
    const { workDir } = await finishedFlow();
    const singleFlag = publishOptions(workDir, { single: true });
    await publishFlow(singleFlag.options);
    expect(singleFlag.plans[0]!.singlePrReason).toBe('--single');
  });

  it('publish.stack: false: the plan says the flow goes out as one PR because of the config', async () => {
    const { workDir } = await finishedFlow();
    const stackDisabled = publishOptions(workDir, { config: { ...TEST_CONFIG, publish: { ...TEST_CONFIG.publish, stack: false } } });
    await publishFlow(stackDisabled.options);
    expect(stackDisabled.plans[0]!.singlePrReason).toBe('publish.stack: false');
  });

  /** A finished two-group chain (g1: two tasks, g2: one) published as a stack onto a GitHub fake. */
  async function publishedStack() {
    const flow = await finishedFlow();
    const g1 = loadState(flow.workDir).groups.g1!.head!;
    const finalHead = git(flow.repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final');
    const github = githubFake();
    const run = publishOptions(flow.workDir, { fetcher: github.fetcher });
    const published = await publishFlow(run.options);
    return { ...flow, ...run, g1, finalHead, github, published };
  }

  it('stack: the plan has a PR per group, each on the branch of the one before; the lowest ready, the rest drafts', async () => {
    const { plans, g1, finalHead } = await publishedStack();
    expect(plans[0]!.singlePrReason).toBeUndefined();
    expect(plans[0]!.stack).toMatchObject([
      { group: 'g1', title: 'Cart limit (1/2): Limit rule', branch: 'feat/cart-limit-1', base: 'main', head: g1, commits: 2, draft: false },
      { group: 'g2', title: 'Cart limit (2/2): Configuration', branch: 'feat/cart-limit-2', base: 'feat/cart-limit-1', head: finalHead, draft: true },
    ]);
  });

  it('stack: each PR\'s size is its own diff, not the feature\'s', async () => {
    const { plans } = await publishedStack();
    // the fake implementer commits one one-line file per task: g1 has two tasks, g2 one
    expect(plans[0]!.stack!.map((pull) => [pull.size.prod, pull.size.tests])).toEqual([
      [2, 0],
      [1, 0],
    ]);
    expect(plans[0]!.size.prod).toBe(3);
  });

  it('stack: every branch pushed, a PR on each, and the lower PR\'s list links the one opened after it', async () => {
    const { bare, workDir, g1, finalHead, github, log } = await publishedStack();
    expect(git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-1')).toBe(g1);
    expect(git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-2')).toBe(finalHead);
    expect(github.pulls.map((pull) => [pull.number, pull.head, pull.base, pull.draft])).toEqual([
      [1, 'feat/cart-limit-1', 'main', false],
      [2, 'feat/cart-limit-2', 'feat/cart-limit-1', true],
    ]);
    expect(github.pulls[0]!.body).toContain('2. [Configuration](https://github.com/acme/shop/pull/2)');
    expect(github.pulls[1]!.body).toContain('1. [Limit rule](https://github.com/acme/shop/pull/1)');
    expect(github.pulls[0]!.body).toContain('"group":"g1"');
    expect(fs.readFileSync(path.join(workDir, 'pr-1.md'), 'utf8')).toBe(github.pulls[0]!.body);
    expect(log).toContain('PR opened 2/2: https://github.com/acme/shop/pull/2');
  });

  it('stack: the state records every PR, the event counts them, and the work branches are cleaned up', async () => {
    const { repo, workDir, g1, finalHead, published } = await publishedStack();
    expect(published).toMatchObject({ branch: 'feat/cart-limit-2', base: 'main', head: finalHead, url: 'https://github.com/acme/shop/pull/1' });
    expect(loadState(workDir).published!.stack).toEqual([
      { group: 'g1', branch: 'feat/cart-limit-1', base: 'main', head: g1, url: 'https://github.com/acme/shop/pull/1', title: 'Cart limit (1/2): Limit rule', notes_of: ['g1'] },
      { group: 'g2', branch: 'feat/cart-limit-2', base: 'feat/cart-limit-1', head: finalHead, url: 'https://github.com/acme/shop/pull/2', title: 'Cart limit (2/2): Configuration', notes_of: ['g2'] },
    ]);
    expect(readEvents(workDir).at(-1)).toMatchObject({ type: 'flow_published', branch: 'feat/cart-limit-2', url: 'https://github.com/acme/shop/pull/1', pulls: 2 });
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/')).toBe('');
  });

  it('a branch of the stack already on origin, not pushed by this flow, stops before the plan; nothing is pushed', async () => {
    const { repo, bare, workDir } = await finishedFlow();
    const theirs = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    git(repo, 'push', '-q', 'origin', `${theirs}:refs/heads/feat/cart-limit-1`);
    const { options, plans } = publishOptions(workDir, { fetcher: githubFake().fetcher });

    await expect(publishFlow(options)).rejects.toThrow(/origin\/feat\/cart-limit-1 already exists, and no earlier publish of this flow pushed it; nothing pushed/);
    expect(plans).toEqual([]);
    expect(git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-1')).toBe(theirs);
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/cart-limit-2')).toBe('');
  });

  it('a branch someone pushes while the plan waits for the human: the lease stops the whole push', async () => {
    const { repo, bare, workDir } = await finishedFlow();
    const theirs = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const pushMeanwhile = async () => (git(repo, 'push', '-q', 'origin', `${theirs}:refs/heads/feat/cart-limit-1`), true);
    const { options } = publishOptions(workDir, { fetcher: githubFake().fetcher, confirm: pushMeanwhile });

    await expect(publishFlow(options)).rejects.toThrow(/stale info|rejected/);
    expect(git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-1')).toBe(theirs);
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/cart-limit-2')).toBe('');
  });

  it('no approved plan: one PR, with the reason', async () => {
    const { workDir } = await finishedFlow();
    fs.rmSync(path.join(workDir, 'tasks.approved.yaml'));
    const { options, plans } = publishOptions(workDir);
    await publishFlow(options);
    expect(plans[0]!.stack).toBeUndefined();
    expect(plans[0]!.singlePrReason).toBe('no approved plan (tasks.approved.yaml)');
  });

  it('a chain where only one group has commits of its own: one PR, with the reason', async () => {
    const { repo, workDir } = await finishedFlow();
    const state = loadState(workDir);
    // g1's branch at the target: nothing of its own under g2
    state.groups.g1!.head = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    saveState(workDir, state);
    const { options, plans, log } = publishOptions(workDir);
    await publishFlow(options);
    expect(plans[0]!.stack).toBeUndefined();
    expect(plans[0]!.singlePrReason).toBe('only g2 has commits of its own');
    expect(log).toContain('Group g1 has no commits of its own: no PR of its own; its review notes go to the PR above');
  });

  it('stack: the top PR carries the review notes of a group in another repo; the lower one does not', async () => {
    const { root, workDir } = await finishedFlow();
    const state = loadState(workDir);
    execFileSync('git', ['init', '-q', path.join(root, 'services', 'api')], { env: gitEnv() });
    state.origin.workspaceRoot = root;
    const apiNit = { id: 'F9', severity: 'nit', message: 'api nit', ...QUOTED, fingerprint: 'f9' };
    state.groups.g9 = { status: 'done', tasks: {}, repo: 'api', review: { rounds: [{ round: 1, finished_at: '', findings: [apiNit] }] } } as unknown as FlowState['groups'][string];
    saveState(workDir, state);

    await publishFlow(publishOptions(workDir, { fetcher: githubFake().fetcher }).options);

    expect(fs.readFileSync(path.join(workDir, 'pr-2.md'), 'utf8')).toContain('- **g9:** `src/Cart.java:2` api nit');
    expect(fs.readFileSync(path.join(workDir, 'pr-1.md'), 'utf8')).not.toContain('**g9:**');
  });

  it('stack published again: the same PRs are updated, nothing pushed twice', async () => {
    const { workDir } = await finishedFlow();
    const github = githubFake();
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);
    const again = publishOptions(workDir, { fetcher: github.fetcher });

    await publishFlow(again.options);

    expect(github.pulls).toHaveLength(2);
    expect(again.log).toContainEqual(expect.stringMatching(/^origin\/feat\/cart-limit-2 already has [0-9a-f]{12}; no push$/));
    expect(again.log).toContain('PR updated 1/2: https://github.com/acme/shop/pull/1');
  });

  /** The state as if the last publish had one more group below: the stack's lowest PR was another one then. */
  function lastPublishHadAnotherLowest(workDir: string) {
    const state = loadState(workDir);
    state.published!.stack!.unshift({ group: 'g0', branch: 'feat/cart-limit-0', base: 'main', head: state.published!.head });
    state.published!.lowest = 'feat/cart-limit-0';
    saveState(workDir, state);
  }

  it('stack published again: a lowest PR the human turned into a draft stays a draft', async () => {
    const { workDir } = await finishedFlow();
    const github = githubFake();
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);
    github.pulls[0]!.draft = true;

    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);

    expect(github.pulls.map((pull) => pull.draft)).toEqual([true, true]);
    expect(github.requests.map((request) => request.url)).not.toContain('https://api.github.com/graphql');
  });

  it('stack published again: a draft that is now the lowest (the last publish had another one) is marked ready', async () => {
    const { workDir } = await finishedFlow();
    const github = githubFake();
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);
    github.pulls[0]!.draft = true;
    lastPublishHadAnotherLowest(workDir);
    const again = publishOptions(workDir, { fetcher: github.fetcher });

    await publishFlow(again.options);

    expect(github.pulls.map((pull) => pull.draft)).toEqual([false, true]);
    expect(again.log).toContain('PR updated 1/2: https://github.com/acme/shop/pull/1; now the lowest, out of draft and ready for review');
  });

  it('stack published again: the draft that became the lowest is still marked ready on the retry after its PR step failed', async () => {
    const { workDir } = await finishedFlow();
    const github = githubFake();
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);
    github.pulls[0]!.draft = true;
    lastPublishHadAnotherLowest(workDir);
    github.refusals.ready = 1;

    await expect(publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options)).rejects.toThrow(/PR 1\/2 was not opened: .*did not leave draft/);
    const retry = publishOptions(workDir, { fetcher: github.fetcher });
    await publishFlow(retry.options);

    expect(github.pulls.map((pull) => pull.draft)).toEqual([false, true]);
    expect(retry.log).toContain('PR updated 1/2: https://github.com/acme/shop/pull/1; now the lowest, out of draft and ready for review');
  });

  it('back to a single PR after a stack: the human\'s draft of the whole-flow PR stays a draft', async () => {
    const { workDir } = await finishedFlow();
    const github = githubFake();
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher, single: true }).options);
    github.pulls[0]!.draft = true;
    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher }).options);

    await publishFlow(publishOptions(workDir, { fetcher: github.fetcher, single: true }).options);

    expect(github.pulls[0]!.draft).toBe(true);
    expect(github.requests.map((request) => request.url)).not.toContain('https://api.github.com/graphql');
  });

  it('a plan that is not a chain goes out as one PR, with the reason', async () => {
    const parallel = `groups:
  - { id: g1, repo: ., title: Rule, rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
  - { id: g2, repo: ., title: Endpoint, rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: y, tier: standard, acceptance: [AC-1] }] }
`;
    const { workDir } = await finishedFlow({ breakdown: { files: { 'tasks.yaml': parallel } } }, NO_STACK_CONFIG);
    const { options, plans } = publishOptions(workDir);
    await publishFlow(options);
    expect(plans[0]!.stack).toBeUndefined();
    expect(plans[0]!.singlePrReason).toBe('the plan is not a chain: g2 does not sit on g1 alone');
  });

  it('a PR that failed after the push: rerun pushes nothing new and opens it', async () => {
    const { workDir } = await finishedFlow();
    const failing = publishOptions(workDir, { single: true, fetcher: fakeFetch([{ status: 502, body: { message: 'bad gateway' } }]).fetcher });
    await expect(publishFlow(failing.options)).rejects.toThrow(/Branch pushed, but PR was not opened[\s\S]*agentic publish cart-limit/);
    expect(loadState(workDir)).toMatchObject({ outcome: 'published', published: { branch: 'feat/cart-limit' } });
    expect(loadState(workDir).published?.url).toBeUndefined();

    const retry = publishOptions(workDir, { single: true });
    expect(await publishFlow(retry.options)).toMatchObject({ url: 'https://github.com/acme/shop/pull/1' });
    expect(retry.log).toContainEqual(expect.stringMatching(/^origin\/feat\/cart-limit already has [0-9a-f]{12}; no push$/));
  });

  it('forge none: push and a link to open the PR by hand', async () => {
    const { bare, workDir } = await finishedFlow();
    const { options, log, requests } = publishOptions(workDir, { single: true, forge: undefined });
    await publishFlow(options);
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/')).toBe('refs/heads/feat/cart-limit');
    expect(requests).toEqual([]);
    expect(log).toContainEqual(expect.stringMatching(/^! No PR opened: profile .* has no `forge`[\s\S]*forge: \{ type: github/));
    expect(log).toContainEqual(expect.stringMatching(/^Create the PR: https:\/\/github\.com\/acme\/shop\/compare\/main\.\.\.feat%2Fcart-limit\?expand=1/));
  });

  it('a ticket titled "… (#5)" without tracker_key closes issue #5', async () => {
    const { workDir } = await finishedFlow();
    const file = ['ticket.approved.md', 'ticket.md'].map((name) => path.join(workDir, name)).find((candidate) => fs.existsSync(candidate))!;
    const { body } = parseMarkdown(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `---\nstatus: ready\ntitle: Material upload (#5)\n---\n${body}`);
    const { options } = publishOptions(workDir, { single: true });
    await publishFlow(options);
    expect(fs.readFileSync(path.join(workDir, 'pr.md'), 'utf8')).toMatch(/^Closes #5$/m);
  });

  it('a flow that is not done is refused', async () => {
    const { workDir } = await finishedFlow();
    const state = loadState(workDir);
    saveState(workDir, { ...state, status: 'paused' });
    await expect(publishFlow(publishOptions(workDir).options)).rejects.toThrow(/is not ready to publish \(status paused/);
  });
});

/** A repo with `origin/main`, a local commit on top, and a flow started with `main` as its target. */
async function targetedFlow(config: AgenticConfig = TEST_CONFIG) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv() });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  git(repo, 'config', 'url.' + bare + '.insteadOf', 'https://github.com/acme/shop.git');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  fs.writeFileSync(path.join(repo, 'local.txt'), 'not pushed\n');
  git(repo, 'add', 'local.txt');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local work');
  const target = flowTarget(repo)!;
  const harnesses = fakeRegistry();
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo }, target });
  const context: FlowContext = { workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates(), checksTrusted: true };
  expect((await runFlow(context)).outcome).toBe('ready_to_publish');
  return { root, repo, bare, workDir, target, context };
}

/** Someone else's commit lands on `origin/main`. */
function advanceOrigin(root: string, bare: string, file: string, content: string): string {
  const other = path.join(root, 'other');
  if (!fs.existsSync(other)) execFileSync('git', ['clone', '-q', bare, other], { env: gitEnv() });
  git(other, 'pull', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(other, file), content);
  git(other, 'add', file);
  git(other, '-c', 'user.name=other', '-c', 'user.email=other@example.com', 'commit', '-q', '-m', `other: ${file}`);
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  return git(other, 'rev-parse', 'HEAD');
}

describe('agentic publish: the target branch', () => {
  it('the flow starts at the target tip on origin, not at the local HEAD', async () => {
    const { repo, workDir, target } = await targetedFlow();
    const state = loadState(workDir);
    expect(state.target).toEqual({ branch: 'main', commit: git(repo, 'rev-parse', 'origin/main') });
    expect(state.groups.g1!.baseRef).toBe(target.commit);
    expect(git(repo, 'ls-tree', '--name-only', 'refs/heads/agentic/cart-limit/_final')).not.toContain('local.txt');

    const { options, plans, log } = publishOptions(workDir, { single: true });
    await publishFlow(options);
    expect(plans[0]).toMatchObject({ base: 'main', foreignCommits: 0 });
    expect(plans[0]!.rebasedOnto).toBeUndefined();
    expect(log.join('\n')).not.toContain('moving the work');
  });

  it('moved since the start: rebased onto the new tip, checks run there, the rebased head is pushed', async () => {
    const { root, repo, bare, workDir, target, context } = await targetedFlow({ ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['true'] } });
    const tip = advanceOrigin(root, bare, 'other.txt', 'theirs\n');
    const { options, plans, log } = publishOptions(workDir, { single: true, rebase: (request) => rebaseFeature(context, request) });

    const published = await publishFlow(options);

    expect(plans[0]).toMatchObject({ base: 'main', rebasedOnto: 1, commits: 3 });
    expect(log).toContainEqual(expect.stringMatching(/^origin\/main has 1 new commit since the flow started; moving the work/));
    expect(readEvents(workDir)).toContainEqual(expect.objectContaining({ type: 'checks_done', owner: '_rebase' }));
    const pushed = git(bare, 'rev-parse', 'refs/heads/feat/cart-limit');
    expect(published!.head).toBe(pushed);
    expect(git(bare, 'rev-parse', `${pushed}~3`)).toBe(tip);
    expect(git(bare, 'log', '--format=%s', `${tip}..${pushed}`).split('\n')).toEqual(['fake: g2-t1.txt', 'fake: g1-t2.txt', 'fake: g1-t1.txt']);
    expect(loadState(workDir).target).toEqual({ branch: 'main', commit: tip });
    expect(target.commit).not.toBe(tip);
    // the group branches hold the same patches as the pushed ones: cleaned up
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/')).toBe('');
    expect(log.join('\n')).not.toContain('Keeping branches');
  });

  it('stack after the target moved: every PR rebased with its group, the lower heads carried along', async () => {
    const { root, repo, bare, workDir, context } = await targetedFlow({ ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['true'] } });
    const tip = advanceOrigin(root, bare, 'other.txt', 'theirs\n');
    const { options, plans, log } = publishOptions(workDir, { fetcher: githubFake().fetcher, rebase: (request) => rebaseFeature(context, request) });

    await publishFlow(options);

    expect(plans[0]).toMatchObject({ rebasedOnto: 1 });
    const lower = git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-1');
    const upper = git(bare, 'rev-parse', 'refs/heads/feat/cart-limit-2');
    expect(git(bare, 'log', '--format=%s', `${tip}..${lower}`).split('\n')).toEqual(['fake: g1-t2.txt', 'fake: g1-t1.txt']);
    expect(git(bare, 'log', '--format=%s', `${lower}..${upper}`).split('\n')).toEqual(['fake: g2-t1.txt']);
    expect(plans[0]!.stack![0]!.head).toBe(lower);
    expect(loadState(workDir).groups.g1!.head).toBe(lower);
    // the lowest PR goes out ready to merge: its own code was checked, not only the top's
    expect(readEvents(workDir).filter((event) => event.type === 'checks_done' && event.owner === '_rebase').map((event) => event.type === 'checks_done' && event.label)).toEqual([`onto-${tip.slice(0, 8)}-g1`, `onto-${tip.slice(0, 8)}`]);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/')).toBe('');
    expect(log.join('\n')).not.toContain('Keeping branches');
  });

  it('a conflict with the moved target stops before the push; nothing changes', async () => {
    const { root, repo, bare, workDir, target, context } = await targetedFlow();
    const before = git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final');
    advanceOrigin(root, bare, 'g1-t1.txt', 'theirs\n');
    const { options } = publishOptions(workDir, { rebase: (request) => rebaseFeature(context, request) });

    await expect(publishFlow(options)).rejects.toThrow(/conflicts with it \(g1-t1\.txt\); nothing pushed[\s\S]*git rebase --rebase-merges --onto origin\/main/);
    expect(git(bare, 'for-each-ref', 'refs/heads/feat/')).toBe('');
    expect(git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final')).toBe(before);
    expect(loadState(workDir)).toMatchObject({ target, outcome: 'ready_to_publish' });
  });

  it('checks red on the rebased code stop before the push', async () => {
    const { root, repo, bare, workDir, context } = await targetedFlow({ ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['test ! -f breaker.txt'] } });
    const before = git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final');
    advanceOrigin(root, bare, 'breaker.txt', 'x\n');
    const { options } = publishOptions(workDir, { single: true, rebase: (request) => rebaseFeature(context, request) });

    await expect(publishFlow(options)).rejects.toThrow(/checks red after the rebase onto origin\/main; nothing pushed[\s\S]*test ! -f breaker\.txt/);
    expect(git(bare, 'for-each-ref', 'refs/heads/feat/')).toBe('');
    expect(git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final')).toBe(before);
  });

  it('stack: checks red on a lower PR\'s rebased code stop before the push, though the top is green', async () => {
    const { root, bare, workDir, context } = await targetedFlow({ ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['true'] } });
    advanceOrigin(root, bare, 'other.txt', 'theirs\n');
    // g2's file is only on the top PR: red on the lower one
    const rebaseContext = { ...context, config: { ...context.config, review: { ...context.config.review, checks: ['test -f g2-t1.txt'] } } };
    const { options } = publishOptions(workDir, { fetcher: githubFake().fetcher, rebase: (request) => rebaseFeature(rebaseContext, request) });

    await expect(publishFlow(options)).rejects.toThrow(/checks red after the rebase onto origin\/main \(code of group g1, a PR lower in the stack\); nothing pushed[\s\S]*test -f g2-t1\.txt/);
    expect(git(bare, 'for-each-ref', 'refs/heads/feat/')).toBe('');
  });

  it('stack after the target moved, a lowest group with nothing of its own: it lands on the new tip, no checks on the old one', async () => {
    const { root, bare, workDir, context } = await targetedFlow();
    const state = loadState(workDir);
    state.groups.g1!.head = state.target!.commit;
    saveState(workDir, state);
    const tip = advanceOrigin(root, bare, 'other.txt', 'theirs\n');
    // the old tip has no other.txt: checks run there would be red
    const rebaseContext = { ...context, config: { ...context.config, review: { ...context.config.review, checks: ['test -f other.txt'] } } };
    const { options, plans } = publishOptions(workDir, { fetcher: githubFake().fetcher, rebase: (request) => rebaseFeature(rebaseContext, request) });

    await publishFlow(options);

    expect(plans[0]!.singlePrReason).toBe('only g2 has commits of its own');
    expect(loadState(workDir).groups.g1!.head).toBe(tip);
    expect(readEvents(workDir).filter((event) => event.type === 'checks_done' && event.owner === '_rebase').map((event) => event.type === 'checks_done' && event.label)).toEqual([`onto-${tip.slice(0, 8)}`]);
  });

  /** The target moved and a branch of the stack is someone else's on origin: the publish is refused after the rebase. */
  async function refusedAfterRebase() {
    const flow = await targetedFlow({ ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['true'] } });
    const finalBefore = git(flow.repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final');
    const g1Before = loadState(flow.workDir).groups.g1!.head;
    advanceOrigin(flow.root, flow.bare, 'other.txt', 'theirs\n');
    git(flow.repo, 'push', '-q', 'origin', `${flow.target.commit}:refs/heads/feat/cart-limit-1`);
    const rebase = (request: Parameters<typeof rebaseFeature>[1]) => rebaseFeature(flow.context, request);
    await expect(publishFlow(publishOptions(flow.workDir, { fetcher: githubFake().fetcher, rebase }).options)).rejects.toThrow(/origin\/feat\/cart-limit-1 already exists/);
    return { ...flow, finalBefore, g1Before, rebase };
  }

  it('a foreign branch after the target moved: the work branches and the state stay where they were', async () => {
    const { repo, workDir, target, finalBefore, g1Before } = await refusedAfterRebase();
    expect(git(repo, 'rev-parse', 'refs/heads/agentic/cart-limit/_final')).toBe(finalBefore);
    expect(loadState(workDir)).toMatchObject({ target, groups: { g1: { head: g1Before } } });
  });

  it('a foreign branch after the target moved, then removed: the rerun rebases again and publishes', async () => {
    const { bare, workDir, rebase } = await refusedAfterRebase();
    git(bare, 'update-ref', '-d', 'refs/heads/feat/cart-limit-1');
    const rerun = publishOptions(workDir, { fetcher: githubFake().fetcher, rebase });

    await publishFlow(rerun.options);

    expect(rerun.plans[0]).toMatchObject({ rebasedOnto: 1 });
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/')).toBe('refs/heads/feat/cart-limit-1\nrefs/heads/feat/cart-limit-2');
  });

  it('a repo without origin has no target; --base there is an error', () => {
    const repo = committedRepo(tmpDir());
    expect(flowTarget(repo)).toBeUndefined();
    expect(() => flowTarget(repo, 'develop')).toThrow(/--base develop: the repo has no `origin` remote/);
  });
});

describe('publish: stack layout', () => {
  const group = (id: string, depends_on: string[] = []) => ({ id, repo: '.', title: id.toUpperCase(), rationale: 'r', depends_on, tasks: [] });
  const heads = { g1: 'a', g2: 'b', g3: 'c' };
  const chain = ['a', 'b', 'c', 'top'];
  const linear = (ancestor: string, descendant: string) => chain.indexOf(ancestor) <= chain.indexOf(descendant);

  it('a chain gives a PR per group with its head; one group gives none', () => {
    expect(stackLayout({ groups: [group('g1'), group('g2', ['g1']), group('g3', ['g2'])], heads, featureHead: 'top', isAncestor: linear }).groups.map((entry) => [entry.id, entry.title, entry.head])).toEqual([
      ['g1', 'G1', 'a'],
      ['g2', 'G2', 'b'],
      ['g3', 'G3', 'c'],
    ]);
    expect(stackLayout({ groups: [group('g1')], heads, featureHead: 'top', isAncestor: linear })).toEqual({ groups: [] });
  });

  it('a group on two of them, or branches that do not lie one on another, give one PR with the reason', () => {
    expect(stackLayout({ groups: [group('g1'), group('g2', ['g1']), group('g3', ['g1', 'g2'])], heads, featureHead: 'top', isAncestor: linear }).reason).toBe('the plan is not a chain: g3 does not sit on g2 alone');
    expect(stackLayout({ groups: [group('g1'), group('g2', ['g1'])], heads: { g1: 'a' }, featureHead: 'top', isAncestor: linear }).reason).toBe('missing group branches g2');
    expect(stackLayout({ groups: [group('g1'), group('g2', ['g1'])], heads, featureHead: 'top', isAncestor: (ancestor) => ancestor !== 'a' }).reason).toBe("the group branches don't sit one on another: g2 doesn't contain g1");
    expect(stackLayout({ groups: [group('g1'), group('g2', ['g1'])], heads, featureHead: 'top', isAncestor: (ancestor) => ancestor !== 'b' }).reason).toBe("the group branches don't sit one on another: the final review doesn't contain g2");
  });
});

describe('publish: branches kept between publishes', () => {
  const previous = new Map([
    ['g1', 'feat/x-1'],
    ['g2', 'feat/x-2'],
    ['g3', 'feat/x-3'],
  ]);

  it('a group keeps its branch from the last publish, even when a group under it dropped out', () => {
    // g2 lost its commits: by position g3 would now be `-2`
    expect(keepGroupBranches(['feat/x-1', 'feat/x-2'], ['g1', 'g3'], previous)).toEqual(['feat/x-1', 'feat/x-3']);
  });

  it('a new group takes a fresh name past every old one', () => {
    expect(keepGroupBranches(['feat/x-1', 'feat/x-2', 'feat/x-3'], ['g1', 'g4', 'g3'], previous)).toEqual(['feat/x-1', 'feat/x-2-2', 'feat/x-3']);
  });

  it('a first publish takes the names as generated', () => {
    expect(keepGroupBranches(['a', 'b'], ['g1', 'g2'], new Map())).toEqual(['a', 'b']);
  });
});
