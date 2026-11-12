import path from 'node:path';
import type { GateName } from '../config/types.js';
import type { SessionKind } from '../harness/types.js';
import type { LineCounts } from '../publish/size.js';
import type { GateDecision } from './gates.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import type { FlowState, Pause, StageId } from './state.js';

/**
 * What happened in a flow, in order. Consumers: notifications (`notify.on` matches `type`),
 * the dashboard, tracker hooks. `state.json` stays the source of truth for where the flow is.
 */
export type FlowEvent =
  | { type: 'flow_started'; resumed: boolean }
  | { type: 'stage_started'; stage: StageId }
  | { type: 'stage_done'; stage: StageId }
  | { type: 'session_started'; kind: SessionKind; group?: string; task?: string; round?: number; harness: string; model: string; effort: string }
  | { type: 'session_done'; kind: SessionKind; group?: string; task?: string; round?: number; session_id: string; exit_code: number; duration_ms: number }
  | { type: 'checks_started'; group?: string; owner: string; label: string; commands: string[] }
  | { type: 'checks_done'; group?: string; owner: string; label: string; passed: boolean; duration_ms: number; results: CheckResult[] }
  | { type: 'review_round'; group?: string; round: number; blocking: number }
  | { type: 'human_needed'; gate: GateName; group?: string; summary: string }
  | { type: 'gate_decided'; gate: GateName; group?: string; action: GateDecision['action'] }
  /** `message`: the group's size warning (`GroupSize.warning`), for notify's `AGENTIC_MESSAGE`. */
  | { type: 'group_done'; group: string; size?: LineCounts; message?: string }
  /** The group waits for `resume` (or failed); the other groups may go on meanwhile. */
  | { type: 'group_blocked'; group: string; reason: Pause['reason']; failed?: true; message?: string }
  | { type: 'rate_limited'; harness: string; group?: string }
  | { type: 'flow_paused'; reason: Pause['reason']; group?: string; message?: string }
  | { type: 'flow_done'; outcome: NonNullable<FlowState['outcome']> }
  | { type: 'flow_failed'; reason: Pause['reason']; group?: string; message?: string }
  | { type: 'flow_aborted'; message?: string }
  | { type: 'flow_published'; branch: string; url?: string; pulls?: number }
  | { type: 'flow_restacked'; merged: number; pushed: number; url?: string };

/** One command of `checks_done`; `log` is the full output on the host. */
export interface CheckResult {
  command: string;
  exit_code: number;
  timed_out?: boolean;
  duration_ms: number;
  log: string;
}

export type FlowEventRecord = FlowEvent & { at: string; slug: string };

export function eventsFile(workDir: string): string {
  return path.join(workDir, 'events.jsonl');
}

export function appendEvent(workDir: string, slug: string, event: FlowEvent): FlowEventRecord {
  const record: FlowEventRecord = { at: new Date().toISOString(), slug, ...event };
  appendJsonLine(eventsFile(workDir), record);
  return record;
}

/** Skips truncated lines left by a killed process. */
export function readEvents(workDir: string): FlowEventRecord[] {
  return readJsonLines(eventsFile(workDir), (value): value is FlowEventRecord => typeof (value as FlowEventRecord | null)?.type === 'string');
}
