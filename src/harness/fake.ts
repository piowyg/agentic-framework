import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from '../config/git.js';
import type { HarnessName } from '../config/types.js';
import { CONTRACT_VERSION, contractFile } from '../contracts/index.js';
import { hostEnv, runProcess } from '../sandbox/process.js';
import type { AgentView, ExecOptions, Sandbox, SessionWorkspace } from '../sandbox/types.js';
import type {
  Harness,
  HarnessCommand,
  HarnessRegistry,
  HarnessStatus,
  ProcessResult,
  SessionKind,
  SessionRequest,
  SessionResult,
  Usage,
} from './types.js';

export interface FakeReply {
  /** Written to the session's `out/`, as a real session would. */
  files?: Record<string, string>;
  /** Written to the working directory and committed there, as an implementer would. */
  commit?: Record<string, string>;
  /** Written to the working directory and left uncommitted. */
  uncommitted?: Record<string, string>;
  /** Deleted from the working directory, the deletion of a tracked file committed: an agent cleaning up its earlier attempt. */
  removed?: string[];
  /**
   * The session's JSON contract artifact (`implement.json`, `review-spec.json`, …), written to `out/`.
   * `contract` and a review's `coverage` are filled in when absent (spec axis: every AC in scope met).
   */
  report?: Record<string, unknown>;
  output?: string;
  exitCode?: number;
  usage?: Usage;
  rateLimited?: boolean;
  rateLimitResetsAt?: number;
  transient?: boolean;
  /** The session got to work before failing; by default when it changed code. */
  startedWork?: boolean;
  timedOut?: boolean;
  /** How long the session "ran"; 1 ms by default. */
  durationMs?: number;
  /** The harness's own session id (as Codex reports it); otherwise the orchestrator's. */
  sessionId?: string;
  /** The event stream of a headless session. */
  transcript?: string;
  /** Simulates a crashed session. */
  throws?: string;
  /** Interactive: the human left (Ctrl+C, `/exit`) before confirming, so no `.done`; otherwise the session writes it. */
  left?: boolean;
}

export type FakeScript = Partial<Record<SessionKind, FakeReply | ((request: SessionRequest, call: number) => FakeReply)>>;

const FAKE_BINARY = 'agentic-fake';

/** Replies waiting for the sandbox to "run" them, by command id. */
type PendingReplies = Map<string, FakeReply>;

/**
 * Deterministic, token-free harness. Unscripted stages get a valid default reply.
 * Its commands only run in `FakeSandbox`, which plays the reply in-process.
 */
export class FakeHarness implements Harness {
  constructor(
    readonly name: HarnessName,
    private readonly script: FakeScript,
    /** Shared between instances to keep call order. */
    readonly calls: SessionRequest[],
    private readonly counters: Map<SessionKind, number>,
    private readonly pending: PendingReplies,
  ) {}

  async status(): Promise<HarnessStatus> {
    return { installed: true, version: 'fake' };
  }

  buildCommand(request: SessionRequest): HarnessCommand {
    this.calls.push(request);
    const call = (this.counters.get(request.kind) ?? 0) + 1;
    this.counters.set(request.kind, call);
    const entry = this.script[request.kind];
    const told = this.conversation(request);
    const scripted = typeof entry === 'function' ? entry(request, call) : (entry ?? defaultReply(request, told));
    // a scripted reply without a report still reports success, as the default would
    const reply = withReportFile({ report: defaultReply(request, told).report, ...scripted }, request, told);
    const commandId = String(this.calls.length);
    this.pending.set(commandId, reply);
    return { argv: [FAKE_BINARY, commandId] };
  }

  /** What the session was told: the first prompt and, when resumed, each later message. */
  private conversation(request: SessionRequest): string {
    const session = request.resumeSessionId;
    if (!session) return request.prompt;
    return this.calls
      .filter((call) => call.sessionId === session || call.resumeSessionId === session)
      .map((call) => call.prompt)
      .join('\n\n');
  }

  parseResult(result: ProcessResult, request: SessionRequest): SessionResult {
    const reply = JSON.parse(result.stdout) as Pick<FakeReply, 'output' | 'usage' | 'rateLimited' | 'rateLimitResetsAt' | 'transient' | 'startedWork' | 'sessionId' | 'transcript'>;
    return {
      ...(reply.rateLimitResetsAt && { rateLimitResetsAt: reply.rateLimitResetsAt }),
      ...(reply.transient && { transient: true }),
      ...(reply.startedWork && { startedWork: true }),
      ...(result.timedOut && { timedOut: true }),
      exitCode: result.exitCode,
      output: reply.output ?? '',
      usage: reply.usage ?? { inputTokens: 1000, outputTokens: 200 },
      durationMs: result.durationMs,
      rateLimited: reply.rateLimited,
      sessionId: reply.sessionId ?? request.resumeSessionId ?? request.sessionId,
      transcript: reply.transcript,
    };
  }
}

/** Runs `FakeHarness` commands in-process and the orchestrator's own (git, checks) on the host; the agent sees host paths. */
export class FakeSandbox implements Sandbox {
  readonly label = 'fake';
  readonly isolated = false;

  /** The options of every fake session run, in order. */
  readonly execs: ExecOptions[] = [];

  constructor(private readonly pending: PendingReplies) {}

  view(workspace: SessionWorkspace): AgentView {
    return { codeDir: workspace.codeDir, outDir: workspace.outDir, readOnlyMounts: [...workspace.readOnlyMounts] };
  }

  async exec(command: HarnessCommand, workspace: SessionWorkspace, options: ExecOptions): Promise<ProcessResult> {
    const [binary, commandId = ''] = command.argv;
    if (binary !== FAKE_BINARY) {
      return runProcess(command.argv, { cwd: workspace.codeDir, env: hostEnv(command.env, options.dropEnv), stdin: command.stdin, ...options });
    }
    const reply = this.pending.get(commandId);
    if (!reply) throw new Error(`fake sandbox: unknown command ${commandId}`);
    this.pending.delete(commandId);
    if (reply.throws) throw new Error(reply.throws);
    writeFiles(workspace.outDir, reply.files);
    if (options.doneFile && !reply.left) fs.writeFileSync(options.doneFile, '');
    writeFiles(workspace.codeDir, { ...reply.commit, ...reply.uncommitted });
    for (const file of reply.removed ?? []) fs.rmSync(path.join(workspace.codeDir, file), { force: true });
    const git = (args: string[]) => execFileSync('git', args, { cwd: workspace.codeDir, env: { ...gitEnv(), ...FAKE_IDENTITY }, stdio: 'ignore' });
    if (reply.removed?.length) git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...reply.removed]);
    // a rebase stopped on conflicts (`agentic restack`): the resolution is staged and the rebase continued, as the merge skill asks
    const rebasing = ['rebase-merge', 'rebase-apply'].some((dir) => fs.existsSync(path.join(workspace.codeDir, '.git', dir)));
    if (rebasing && reply.commit && Object.keys(reply.commit).length) {
      git(['add', '--', ...Object.keys(reply.commit)]);
      execFileSync('git', ['rebase', '--continue'], { cwd: workspace.codeDir, env: { ...gitEnv(), ...FAKE_IDENTITY, GIT_EDITOR: 'true' }, stdio: 'ignore' });
    } else if ((reply.commit && Object.keys(reply.commit).length) || reply.removed?.length) {
      if (reply.commit && Object.keys(reply.commit).length) git(['add', '--', ...Object.keys(reply.commit)]);
      // a merge commit keeps the message git prepared, as the merge skill asks
      const merging = fs.existsSync(path.join(workspace.codeDir, '.git', 'MERGE_HEAD'));
      // a resumed session writing the same files again has nothing to commit
      if (merging || staged(git)) git(['commit', '-q', ...(merging ? ['--no-edit'] : ['-m', `fake: ${[...Object.keys(reply.commit ?? {}), ...(reply.removed ?? [])].join(', ')}`])]);
    }
    this.execs.push(options);
    const { output, usage, rateLimited, rateLimitResetsAt, transient, sessionId, transcript } = reply;
    // a session that changed code had answered, as a real harness's transcript would show
    const changedCode = [reply.commit, reply.uncommitted].some((files) => files && Object.keys(files).length > 0) || !!reply.removed?.length;
    const startedWork = reply.startedWork ?? (changedCode || undefined);
    return {
      exitCode: reply.exitCode ?? 0,
      stdout: JSON.stringify({ output, usage, rateLimited, rateLimitResetsAt, transient, startedWork, sessionId, transcript }),
      stderr: '',
      durationMs: reply.durationMs ?? 1,
      ...(reply.timedOut && { timedOut: true }),
    };
  }
}

const FAKE_IDENTITY = { GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@agentic', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@agentic' };

function writeFiles(root: string, files: Record<string, string> = {}): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function fakeRegistry(script: FakeScript = {}): HarnessRegistry & { calls: () => SessionRequest[]; sandbox: Sandbox & { execs: ExecOptions[] } } {
  const calls: SessionRequest[] = [];
  const counters = new Map<SessionKind, number>();
  const pending: PendingReplies = new Map();
  return {
    claude: new FakeHarness('claude', script, calls, counters, pending),
    codex: new FakeHarness('codex', script, calls, counters, pending),
    calls: () => [...calls],
    sandbox: new FakeSandbox(pending),
  };
}

export const FAKE_TICKET = `---
status: ready
title: Cart limit
---
# Cart limit

## Acceptance criteria
- AC-1: A customer has at most 20 items in the cart.
- AC-2: Over the limit they get a refusal with code CART_LIMIT.
`;

export const FAKE_SPEC = `---
status: ready
---
# Spec: cart limit

## Decisions
- The cart limit lives in the domain: one rule for all channels.

## Affected repos
- .

## Contracts
POST /cart/items.

## Test seams
- POST /cart/items

## Risks
None

## Out of scope
None

## External assets
None
`;

export const FAKE_TASKS = `groups:
  - id: g1
    repo: .
    title: Limit rule
    rationale: the rule and the endpoint together make the first working slice
    estimate: { prod: 50, tests: 50 }
    depends_on: []
    tasks:
      - id: t1
        title: Counting items in the cart
        tier: domain
        acceptance: [AC-1, AC-2]
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
      - id: t1
        title: Entry in application.yml
        tier: mechanical
        acceptance: [AC-1]
`;

function defaultReply(request: SessionRequest, told: string): FakeReply {
  switch (request.kind) {
    case 'grill-business':
      return { files: { 'ticket.md': FAKE_TICKET } };
    case 'grill-technical':
      return { files: { 'spec.md': FAKE_SPEC } };
    case 'breakdown':
      return { files: { 'tasks.yaml': FAKE_TASKS } };
    case 'implement':
      // one commit per task, so the work branch moves and dependent groups see it
      return { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { [`${request.group}-${request.task}.txt`]: `${request.task}\n` } };
    case 'fix':
      // a fix commits, so the next round has a new diff to review; every finding it was given is fixed
      return { report: { findings: listedFindings(told, 'Blocking findings to fix:').map((id) => ({ id, status: 'fixed' })) }, commit: { [`fix-${request.group ?? 'feature'}.txt`]: `${request.sessionId}\n` } };
    case 'merge':
      return { report: { status: 'resolved', files: [] } };
    case 'write-tests': {
      // the group's tests are committed: the orchestrator freezes their files
      const file = `${request.group}Test.java`;
      return {
        report: { tests: (request.acceptance ?? []).map((id) => ({ path: file, name: id, ac: [id] })), stubs: [] },
        commit: { [file]: `${(request.acceptance ?? []).join(' ')}\n` },
      };
    }
    default:
      return { report: { findings: [] } };
  }
}

function staged(git: (args: string[]) => void): boolean {
  try {
    git(['diff', '--cached', '--quiet']);
    return false;
  } catch {
    return true;
  }
}

/** Serializes `report` into the kind's contract file. */
function withReportFile(reply: FakeReply, request: SessionRequest, told: string): FakeReply {
  const file = contractFile(request.kind);
  if (!reply.report || !file) return reply;
  const report: Record<string, unknown> = { contract: CONTRACT_VERSION, ...reply.report };
  if (request.kind.startsWith('review-') && !('coverage' in report)) report.coverage = defaultCoverage(request);
  // without a verdict a finding stays open: `not_fixed`, said explicitly as the contract asks
  if (request.kind.startsWith('review-') && !('previous' in report)) {
    const open = listedFindings(told, 'give each a verdict in `previous`');
    if (open.length) report.previous = open.map((id) => ({ id, status: 'not_fixed' }));
  }
  return { ...reply, files: { ...reply.files, [file]: JSON.stringify(report) } };
}

/** Ids of the findings a prompt lists as JSON after `marker`. */
function listedFindings(prompt: string, marker: string): string[] {
  const start = prompt.indexOf(marker);
  const listed = start < 0 ? undefined : /\n(\[[\s\S]*?\n\])/.exec(prompt.slice(start))?.[1];
  return listed ? (JSON.parse(listed) as { id: string }[]).map((finding) => finding.id) : [];
}

function defaultCoverage(request: SessionRequest): unknown {
  switch (request.kind) {
    case 'review-spec':
      return (request.acceptance ?? []).map((ref) => ({ ref, verdict: 'met', evidence: 'fake' }));
    case 'review-standards':
      return { rules: [], tests: [] };
    case 'review-security':
      return { boundaries: ['fake'] };
    default:
      return { checked: ['fake'] };
  }
}
