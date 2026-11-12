import type { GateName } from '../config/types.js';
import type { SizeThresholds } from '../publish/size.js';
import type { Group } from './artifacts.js';

export type GateDecision =
  | { action: 'continue' }
  /** Save and pause until `resume`. */
  | { action: 'stop' }
  /** Ticket gate: push to the tracker and finish. */
  | { action: 'push_and_stop' }
  | { action: 'retry'; note: string }
  /** Review loops: restart the scope from the code reviewed in `round` and fix that round's findings again. */
  | { action: 'rollback'; round: number }
  /** Merge: the human resolves the conflict in a clean clone of their own, then resumes. */
  | { action: 'manual' }
  | { action: 'abort' };

/**
 * What a gate shows, as data: the terminal renders it today, a dashboard later.
 * `breakdown`: the plan; `document`: a ticket or spec with its summary.
 */
export type GateView =
  | { kind: 'breakdown'; file: string; groups: Group[]; acceptance: string[]; warnings: string[]; limits?: SizeThresholds }
  | { kind: 'document'; file: string; title?: string; summary?: string; facts: string[] };

/** A gate's text (events, logs) and, when the gate has one, its structured view. */
export interface GateSummary {
  text: string;
  view?: GateView;
}

export interface GateRequest {
  gate: GateName;
  slug: string;
  workDir: string;
  group?: string;
  summary: string;
  view?: GateView;
  actions: GateDecision['action'][];
  /** Rounds `rollback` may go back to; present only when `actions` offers it. */
  rounds?: number[];
}

export interface GateDecider {
  decide(request: GateRequest): Promise<GateDecision>;
  /** A yes/no question outside any gate; without it the answer is no. */
  confirm?(question: string): Promise<boolean>;
}

export function gateActions(gate: GateName): GateDecision['action'][] {
  if (gate === 'ticket') return ['continue', 'push_and_stop', 'stop'];
  if (gate === 'merge') return ['continue', 'retry', 'manual', 'stop', 'abort'];
  return ['continue', 'retry', 'stop', 'abort'];
}

/** `rollback` goes right after `retry` when there is a round to go back to. */
export function withRollback(actions: GateDecision['action'][], rounds: number[]): GateDecision['action'][] {
  if (!rounds.length) return actions;
  const retryIndex = actions.indexOf('retry');
  return [...actions.slice(0, retryIndex + 1), 'rollback', ...actions.slice(retryIndex + 1)];
}

export class ScriptedGates implements GateDecider {
  readonly seen: GateRequest[] = [];
  readonly asked: string[] = [];
  constructor(
    private readonly decisions: Partial<Record<GateName, GateDecision[]>> = {},
    private readonly answers: boolean[] = [],
  ) {}
  async decide(request: GateRequest): Promise<GateDecision> {
    this.seen.push(request);
    return this.decisions[request.gate]?.shift() ?? { action: 'continue' };
  }
  async confirm(question: string): Promise<boolean> {
    this.asked.push(question);
    return this.answers.shift() ?? false;
  }
}
