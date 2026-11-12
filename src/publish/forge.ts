import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ForgeConfig } from '../config/types.js';
import type { RemoteRepo } from './remote.js';

const exec = promisify(execFile);

export interface PullRequestInput {
  /** The pushed branch. */
  head: string;
  /** The branch it goes into: the target, or the predecessor's branch in a stack. */
  base: string;
  title: string;
  body: string;
  labels: string[];
  /** Opened as a draft; an open PR keeps whatever draft state it has, unless `ready`. */
  draft?: boolean;
  /** An open draft is marked ready for review: the PR just became a stack's lowest, the one to review first. */
  ready?: boolean;
}

export interface PullRequest {
  url: string;
  /** False: an open PR of the same branch was updated instead, and moved onto `base` if it had another. */
  created: boolean;
  /** An open draft was marked ready for review (`ready`). */
  readied?: boolean;
  /** Labels the forge refused; the PR stands without them. */
  warnings: string[];
}

/** The newest PR of a branch as the forge sees it, whatever its state. */
export interface PullRequestState {
  url: string;
  status: 'open' | 'merged' | 'closed';
  draft: boolean;
  /** The branch it goes into; absent when the forge didn't say. */
  base?: string;
  /** The commit at the tip of its branch, as the forge last saw it; absent when the forge didn't say. */
  head?: string;
  /**
   * Merged: the commit on `base` that carries it — the merge commit when there is one, else the squash, else the
   * head itself after a fast-forward. A rebase merge lands new commits whose last one is this one.
   */
  mergeCommit?: string;
}

/** The orchestrator talks to the forge; no agent ever holds its token. */
export interface Forge {
  readonly name: 'github' | 'gitlab';
  openPullRequest(input: PullRequestInput): Promise<PullRequest>;
  /** The newest PR whose head is `branch` (open, merged or closed); undefined when there was none. */
  pullRequestState(branch: string): Promise<PullRequestState | undefined>;
}

export type Fetch = typeof fetch;

export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

/** The forge of `remote`, or undefined for `type: none`. */
export function createForge(config: ForgeConfig, remote: RemoteRepo, token: string, fetcher: Fetch = fetch): Forge | undefined {
  const web = (config.url ?? `https://${remote.host}`).replace(/\/+$/, '');
  switch (config.type) {
    case 'github':
      return remote.host === 'github.com' && !config.url
        ? new GitHubForge('https://api.github.com', 'https://api.github.com/graphql', remote.path, token, fetcher)
        : new GitHubForge(`${web}/api/v3`, `${web}/api/graphql`, remote.path, token, fetcher);
    case 'gitlab':
      return new GitLabForge(`${web}/api/v4`, remote.path, token, fetcher);
    case 'none':
      return undefined;
  }
}

/** Where a human opens the PR by hand (`forge.type: none`), when the host is a known forge. */
export function newPullRequestUrl(remote: RemoteRepo, input: Pick<PullRequestInput, 'head' | 'base'>, type?: ForgeConfig['type']): string | undefined {
  const kind = type && type !== 'none' ? type : remote.host.includes('gitlab') ? 'gitlab' : remote.host.includes('github') ? 'github' : undefined;
  const web = `https://${remote.host}/${remote.path}`;
  if (kind === 'github') return `${web}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}?expand=1`;
  if (kind === 'gitlab') {
    return `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(input.head)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(input.base)}`;
  }
  return undefined;
}

/**
 * The token from `auth`: an environment variable, or the CLI the human is logged in with. Never written anywhere,
 * never part of an error message.
 */
export async function forgeToken(config: ForgeConfig, host: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const auth = config.auth;
  if (!auth) throw new Error(`forge ${config.type}: no \`auth\` in the profile; \`auth: { from: ${config.type === 'gitlab' ? 'glab' : 'gh'} }\` or \`auth: { env: NAME }\``);
  if ('env' in auth) {
    const token = env[auth.env];
    if (!token) throw new Error(`forge ${config.type}: variable \`${auth.env}\` (forge.auth.env) is empty`);
    return token;
  }
  const [command, args] = auth.from === 'gh' ? ['gh', ['auth', 'token', '--hostname', host]] : ['glab', ['config', 'get', 'token', '--host', host]];
  const token = await exec(command, args, { timeout: 15_000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  if (!token) throw new Error(`forge ${config.type}: \`${command}\` gave no token for ${host}; log in (\`${command} auth login --hostname ${host}\`) or use \`auth: { env: NAME }\``);
  return token;
}

abstract class RestForge implements Forge {
  abstract readonly name: 'github' | 'gitlab';

  constructor(
    protected readonly api: string,
    protected readonly repoPath: string,
    private readonly token: string,
    private readonly fetcher: Fetch,
  ) {}

  abstract openPullRequest(input: PullRequestInput): Promise<PullRequest>;
  abstract pullRequestState(branch: string): Promise<PullRequestState | undefined>;

  /** `path` relative to the REST API. */
  protected call<Result>(method: string, path: string, body?: unknown): Promise<Result> {
    return this.send(method, `${this.api}${path}`, `${method} ${path}`, body);
  }

  /** `what` names the call in the error message. */
  protected async send<Result>(method: string, url: string, what: string, body?: unknown): Promise<Result> {
    const response = await this.fetcher(url, {
      method,
      headers: { ...this.headers(), Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'agentic' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new ForgeError(response.status, `${this.name} ${what}: HTTP ${response.status} ${errorDetail(text)}`);
    return (text ? JSON.parse(text) : undefined) as Result;
  }

  protected headers(): Record<string, string> {
    return {};
  }
}

interface GitHubPull {
  number: number;
  html_url: string;
  node_id?: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  /** On an unmerged PR GitHub's test merge, not a commit of the base. */
  merge_commit_sha?: string | null;
  base?: { ref: string };
  head?: { sha: string };
}

class GitHubForge extends RestForge {
  readonly name = 'github';

  constructor(
    api: string,
    private readonly graphql: string,
    repoPath: string,
    token: string,
    fetcher: Fetch,
  ) {
    super(api, repoPath, token, fetcher);
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const repo = `/repos/${this.repoPath}`;
    // by the branch alone: a PR whose base moved (a stack restacked) is the same PR, not a reason for a second one
    const [open] = await this.pullsOf(input.head, 'open');
    const titleAndBody = { title: input.title, body: input.body };
    const pull = open
      ? await this.call<GitHubPull>('PATCH', `${repo}/pulls/${open.number}`, { ...titleAndBody, ...(open.base?.ref !== input.base && { base: input.base }) })
      : await this.call<GitHubPull>('POST', `${repo}/pulls`, { ...titleAndBody, head: input.head, base: input.base, ...(input.draft && { draft: true }) });
    const readied = Boolean(open?.draft && input.ready);
    if (readied) await this.markReady(open!);
    const warnings: string[] = [];
    if (input.labels.length) {
      await this.call('POST', `${repo}/issues/${pull.number}/labels`, { labels: input.labels }).catch((error: Error) => warnings.push(`label ${input.labels.join(', ')}: ${error.message}`));
    }
    return { url: pull.html_url, created: !open, ...(readied && { readied }), warnings };
  }

  async pullRequestState(branch: string): Promise<PullRequestState | undefined> {
    const [pull] = await this.pullsOf(branch, 'all');
    if (!pull) return undefined;
    const merged = Boolean(pull.merged_at);
    return {
      url: pull.html_url,
      status: merged ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
      draft: pull.draft === true,
      ...(pull.base?.ref && { base: pull.base.ref }),
      ...(pull.head?.sha && { head: pull.head.sha }),
      ...(merged && pull.merge_commit_sha && { mergeCommit: pull.merge_commit_sha }),
    };
  }

  /** REST can't take a PR out of draft; GraphQL can, and answers 200 even when it refuses. */
  private async markReady(pull: GitHubPull): Promise<void> {
    // a forge that won't do it stops every retry the same way: the human's "Ready for review" lets the next one through
    const markByHand = 'mark it ready for review on GitHub and retry';
    if (!pull.node_id) throw new Error(`github: PR #${pull.number} has no node_id, so it can't leave draft; ${markByHand}`);
    const answer = await this.send<{ errors?: { message?: string }[] }>('POST', this.graphql, 'GraphQL markPullRequestReadyForReview', { query: MARK_READY, variables: { id: pull.node_id } });
    if (answer?.errors?.length) {
      throw new Error(`github: PR #${pull.number} did not leave draft: ${answer.errors.map((error) => error.message ?? JSON.stringify(error)).join('; ').slice(0, 500)}; ${markByHand}`);
    }
  }

  /** The PRs whose head is `branch`, newest first. */
  private pullsOf(branch: string, state: 'open' | 'all'): Promise<GitHubPull[]> {
    const owner = this.repoPath.split('/')[0]!;
    return this.call<GitHubPull[]>('GET', `/repos/${this.repoPath}/pulls?state=${state}&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=created&direction=desc`);
  }

  protected override headers(): Record<string, string> {
    return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
}

const MARK_READY = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';

interface GitLabMergeRequest {
  iid: number;
  web_url: string;
  state?: 'opened' | 'merged' | 'closed' | 'locked';
  draft?: boolean;
  /** What GitLab before 13.2 calls `draft`. */
  work_in_progress?: boolean;
  target_branch?: string;
  sha?: string;
  merge_commit_sha?: string | null;
  /** Absent on GitLab versions that don't report it, even after a squash. */
  squash_commit_sha?: string | null;
  squash?: boolean;
}

/** GitLab's API has no `draft` field to set: the title prefix is what makes a merge request a draft. */
const GITLAB_DRAFT = 'Draft: ';

class GitLabForge extends RestForge {
  readonly name = 'gitlab';

  async openPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const project = this.project();
    const [open] = await this.requestsOf(input.head, 'opened');
    // a new title without the prefix takes an open draft out of draft: only when asked to
    const wasDraft = Boolean(open && (open.draft ?? open.work_in_progress));
    const readied = wasDraft && Boolean(input.ready);
    const draft = open ? wasDraft && !readied : input.draft;
    // GitLab creates missing labels itself
    const fields = { title: `${draft ? GITLAB_DRAFT : ''}${input.title}`, description: input.body, labels: input.labels.join(',') };
    const request = open
      ? await this.call<GitLabMergeRequest>('PUT', `${project}/merge_requests/${open.iid}`, { ...fields, ...(open.target_branch !== input.base && { target_branch: input.base }) })
      : await this.call<GitLabMergeRequest>('POST', `${project}/merge_requests`, { ...fields, source_branch: input.head, target_branch: input.base });
    return { url: request.web_url, created: !open, ...(readied && { readied }), warnings: [] };
  }

  async pullRequestState(branch: string): Promise<PullRequestState | undefined> {
    const [request] = await this.requestsOf(branch, 'all');
    if (!request) return undefined;
    const merged = request.state === 'merged';
    // a squash whose commit GitLab didn't report has none we can name: its `sha` is the branch tip, not on the base
    const mergeCommit = request.merge_commit_sha ?? request.squash_commit_sha ?? (request.squash ? undefined : request.sha);
    return {
      url: request.web_url,
      status: merged ? 'merged' : request.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(request.draft ?? request.work_in_progress),
      ...(request.target_branch && { base: request.target_branch }),
      ...(request.sha && { head: request.sha }),
      ...(merged && mergeCommit && { mergeCommit }),
    };
  }

  /** The merge requests whose source is `branch`, newest first. */
  private requestsOf(branch: string, state: 'opened' | 'all'): Promise<GitLabMergeRequest[]> {
    return this.call<GitLabMergeRequest[]>('GET', `${this.project()}/merge_requests?state=${state}&source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc`);
  }

  private project(): string {
    return `/projects/${encodeURIComponent(this.repoPath)}`;
  }
}

/** The forge's own message (`{"message": …}`), not the whole response. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; errors?: unknown };
    const detail = parsed.message ?? parsed.error ?? parsed;
    return JSON.stringify(parsed.errors ? { message: detail, errors: parsed.errors } : detail).slice(0, 500);
  } catch {
    return text.slice(0, 200);
  }
}
