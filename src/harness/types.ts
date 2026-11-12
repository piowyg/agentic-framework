import type { Executor, HarnessName, ReviewAxis } from '../config/types.js';
import type { HostAccess } from '../sandbox/host-policy.js';

export type SessionMode = 'interactive' | 'headless';

export type ReviewKind = `review-${ReviewAxis}`;

export type SessionKind =
  | 'grill-business'
  | 'grill-technical'
  | 'breakdown'
  | 'write-tests'
  | 'implement'
  | ReviewKind
  | 'fix'
  | 'merge'
  | 'review-final';

/** Sessions that commit in their clone: their commits leave it as a bundle after the orchestrator verifies them. */
export const COMMITTING_KINDS = ['write-tests', 'implement', 'fix', 'merge'] as const satisfies readonly SessionKind[];
export type CommittingKind = (typeof COMMITTING_KINDS)[number];

/** Paths are as the agent sees them — inside the container under `sandbox.mode: container`. */
export interface SessionRequest {
  kind: SessionKind;
  mode: SessionMode;
  executor: Executor;
  /** The code the session works on. */
  cwd: string;
  /** The only place the session writes its artifacts to; the orchestrator collects them. */
  outDir: string;
  /** Flow artifacts the session reads (ticket, spec, tasks). */
  contextFiles: string[];
  prompt: string;
  skills: string[];
  group?: string;
  task?: string;
  /** Acceptance criteria in scope (also named in the prompt). */
  acceptance?: string[];
  /** Chosen by the orchestrator; a harness that can't take it reports its own in `SessionResult.sessionId`. */
  sessionId: string;
  /** Continue this earlier session (its `SessionResult.sessionId`) instead of starting a new one; `prompt` is the next message. */
  resumeSessionId?: string;
  /** The sandbox isolates the session, so the harness skips its own permission prompts and sandbox. */
  isolated: boolean;
  /** In a container: the host directory mounted as the harness's `sessionsHome` — this session's own, kept for resume and usage. */
  sessionsDir?: string;
  /** On the host: what the harness's own sandbox lets the session read beyond its directories. */
  hostAccess?: HostAccess;
  /** On the host: the hosts the harness's sandbox lets shell commands reach (`.example.com` = its subdomains). */
  network?: string[];
  /**
   * On the host: the session's `run-checks` (`writeChecksRunner`), which runs the repo's `review.checks` the human
   * allowed — the one command the harness lets out of its sandbox, so the session can run the build
   * and tests the orchestrator verifies it with (`~/.gradle`, network, Docker).
   */
  checksRunner?: string;
}

/** What the sandbox runs: no shell, `env` values never land on a command line. */
export interface HarnessCommand {
  argv: string[];
  env?: Record<string, string>;
  /** Host variables a container gets by name when set (the harness's credentials); on the host the command inherits them anyway. */
  passEnv?: readonly string[];
  /** Hosts the harness itself needs on a container's allowlist (a company gateway). */
  allow?: readonly string[];
  stdin?: string;
}

/** A finished process, before the harness interprets it. */
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface Usage {
  /** All input tokens, including cache reads. */
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` served from the prompt cache. */
  cacheReadTokens?: number;
  /**
   * Harness-reported cost of the whole session so far: Claude Code's `total_cost_usd` of a resumed session
   * includes its earlier runs (seen in smoke 92-2), while the tokens are this run's. `appendUsage` logs the difference.
   */
  costUsd?: number;
}

export interface SessionResult {
  exitCode: number;
  output: string;
  usage?: Usage;
  durationMs: number;
  rateLimited?: boolean;
  /** When the rate limit lifts (epoch ms), if the harness says. */
  rateLimitResetsAt?: number;
  /** Failed for a reason a retry may not meet: an overloaded or failing API, the network. */
  transient?: boolean;
  /** The agent got as far as answering before the failure: a retry resumes the session instead of starting over. */
  startedWork?: boolean;
  timedOut?: boolean;
  /** The harness's own session id, for `--resume` and for matching usage, events and the transcript. */
  sessionId?: string;
  /** No final count from the harness (a killed session): `usage`, if any, is a lower bound read from the stream. */
  usagePartial?: true;
  /** The raw event stream of a headless session (JSONL), kept as `transcripts/<session>.jsonl`. */
  transcript?: string;
}

export interface HarnessStatus {
  installed: boolean;
  version?: string;
}

/**
 * A harness CLI as data: it builds the command and reads the result, the sandbox runs it.
 * The orchestrator never lets a harness touch the host directly.
 */
export interface Harness {
  readonly name: HarnessName;
  /**
   * Where under HOME the CLI keeps its sessions; in a container only this is mounted, per session
   * (`SessionRequest.sessionsDir`) — never the CLI's whole home, whose settings, hooks and memory a session could plant.
   */
  readonly sessionsHome?: string;
  status(): Promise<HarnessStatus>;
  buildCommand(request: SessionRequest): HarnessCommand;
  parseResult(result: ProcessResult, request: SessionRequest): SessionResult;
  /**
   * Usage the result doesn't carry in full — an interactive session's (the terminal is the human's), a killed one's:
   * read from the harness's own session files on the host after the session, counting what it did since `startedAt`.
   */
  sessionUsage?(request: SessionRequest, startedAt: number): Usage | undefined;
}

export type HarnessRegistry = Record<HarnessName, Harness>;
