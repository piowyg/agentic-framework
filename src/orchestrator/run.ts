import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedProfile } from '../config/load.js';
import type { ModelCatalog } from '../config/models.js';
import type { AgenticConfig } from '../config/types.js';
import { readFileSafe } from '../fsutil.js';
import type { HarnessRegistry } from '../harness/types.js';
import type { Sandbox } from '../sandbox/types.js';
import { ArtifactError } from './artifacts.js';
import type { CheckRun } from './checks.js';
import { appendEvent, type FlowEvent, type FlowEventRecord } from './events.js';
import type { GateDecider } from './gates.js';
import type { NetworkState } from './network.js';
import { saveState, type FlowState, type Pause, type StageId } from './state.js';

export interface FlowContext {
  workDir: string;
  config: AgenticConfig;
  harnesses: HarnessRegistry;
  /** Where every session runs (`sandbox.mode`, or the fake harness's in-process one). */
  sandbox: Sandbox;
  gates: GateDecider;
  catalog: ModelCatalog;
  /** Pricing, billing, `on_rate_limit` and tracker of the matched profile. */
  profile: ResolvedProfile;
  /** The human allowed this repo's `review.checks` to run on the host (`~/.agentic/trusted-checks.yaml`). */
  checksTrusted?: boolean;
  log?: (message: string) => void;
  /** What runs now under `id` (`line`), or that it finished (none): a terminal shows it live, the log says the outcome. */
  progress?: (id: string, line?: string) => void;
  /** Waits between retries and for a rate limit; tests pass one that doesn't. */
  sleep?: (ms: number) => Promise<void>;
  /** Asks a harness's API from the host when a session keeps failing (`probeNetwork`); without it nobody asks. */
  probe?: (url: string) => Promise<NetworkState>;
  /** Called after each event is appended to `events.jsonl` (notifications, dashboard). */
  onEvent?: (event: FlowEventRecord) => void;
}

/** Stops the current unit of work: `GroupRunner` turns it into the group's outcome, `runFlow` into the flow's status. */
export class Halt extends Error {
  /** A session stopped midway (`session_timeout`, failed retries, a rate limit) after it had started work: a later run resumes it. */
  session?: string;

  constructor(
    readonly status: FlowState['status'],
    readonly pause?: Pause,
    readonly outcome?: FlowState['outcome'],
  ) {
    super(pause?.message ?? status);
  }
}

/** One run of a flow: its context and state, shared by the stage, group and session runners. */
export class FlowRun {
  /** Set when a group aborts the flow; groups still running stop before their next session or gate. */
  stopRequested = false;
  /** `checks` on a base commit that a group is running now, per commit (`CloneWork.baseline`). */
  readonly baselineRuns = new Map<string, Promise<CheckRun[]>>();
  /** Questions about red checks on a base go to the human one at a time (`GroupRunner.baseline`). */
  baselineQuestions: Promise<void> = Promise.resolve();

  constructor(
    readonly context: FlowContext,
    readonly state: FlowState,
  ) {}

  save(): void {
    saveState(this.context.workDir, this.state);
  }

  emit(event: FlowEvent): void {
    const record = appendEvent(this.context.workDir, this.state.slug, event);
    this.context.onEvent?.(record);
  }

  log(message: string): void {
    this.context.log?.(message);
  }

  progress(id: string, line?: string): void {
    this.context.progress?.(id, line);
  }

  note(stage: StageId, note: string, group?: string): void {
    this.state.notes.push({ stage, ...(group && { group }), note, at: new Date().toISOString() });
  }

  /** Throws when another group aborted the flow, so a parallel group doesn't start new work. */
  checkNotStopped(group?: string): void {
    if (this.stopRequested) throw new Halt('paused', { reason: 'human', group, message: 'flow stopped in another group' });
  }

  read(name: string): string {
    const file = path.join(this.context.workDir, name);
    if (!fs.existsSync(file)) throw new ArtifactError(name, ['file not created']);
    return readFileSafe(file, name);
  }
}
