// `stop_on` triggers computed from the review rounds. `max_rounds` and `disputed`
// are the loop's own; `checks_failing` stops a session in `CloneWork`; `budget` is the flow's, checked before every
// session (`BudgetGuard`) whether or not `stop_on` lists it.

import type { StopTrigger } from '../config/types.js';
import type { FindingRecord, ReviewLoopState, RoundRecord } from '../orchestrator/state.js';
import { openFindings } from '../orchestrator/state.js';
import { isOpen } from './findings.js';

/** Fewer blocking findings in a round say nothing about noise: one rejected of one is not a rate. */
export const REJECTION_MIN_REPORTED = 3;

export interface StopReason {
  trigger: 'repeated_finding' | 'no_progress' | 'diff_growth' | 'rejection_rate';
  /** For the human, in the conversation language. */
  detail: string;
}

/**
 * Triggers set off by the last round. `rejection_rate` stops even with nothing left open (the reviewer is
 * unreliable, so its coverage is too); the others only matter while something is open.
 */
export function stopReasons(triggers: StopTrigger[], loop: ReviewLoopState): StopReason[] {
  const rounds = loop.review?.rounds ?? [];
  const current = rounds.at(-1);
  if (!current) return [];
  const previous = rounds.at(-2);
  const open = openFindings(loop);
  const reasons: StopReason[] = [];
  for (const trigger of triggers) {
    if (trigger === 'repeated_finding' && previous && open.length) {
      const fixed = new Set(previous.fixed ?? []);
      const back = open.filter((finding) => fixed.has(finding.fingerprint));
      if (back.length) reasons.push({ trigger, detail: `came back after the fix: ${ids(back)}` });
    }
    if (trigger === 'no_progress' && previous && open.length) {
      const now = new Set(open.map((finding) => finding.fingerprint));
      const setAside = new Set((loop.set_aside ?? []).filter((entry) => entry.ruling !== 'fix').map((entry) => entry.finding.fingerprint));
      const before = previous.findings.filter((finding) => isOpen(finding) && !setAside.has(finding.fingerprint));
      if (before.length && before.every((finding) => now.has(finding.fingerprint))) reasons.push({ trigger, detail: 'the round fixed nothing' });
    }
    if (typeof trigger !== 'object') continue;
    if ('diff_growth' in trigger && open.length) {
      const first = rounds[0]?.diff_lines;
      const last = current.diff_lines;
      if (first && last !== undefined && last > trigger.diff_growth * first) {
        reasons.push({ trigger: 'diff_growth', detail: `the diff grew from ${first} to ${last} lines (limit ×${trigger.diff_growth})` });
      }
    }
    if ('rejection_rate' in trigger) {
      const { reported, rejected } = rejectionCounts(current);
      if (reported >= REJECTION_MIN_REPORTED && rejected / reported > trigger.rejection_rate) {
        reasons.push({ trigger: 'rejection_rate', detail: `rejected ${rejected} of ${reported} blocking findings (limit ${trigger.rejection_rate * 100}%)` });
      }
    }
  }
  return reasons;
}

/**
 * Blocking findings the reviewers wrote this round (downgraded ones included) and how many the evidence rejected.
 * Carried findings were counted in their round; out of scope is a matter of scope, not noise.
 */
export function rejectionCounts(round: RoundRecord): { reported: number; rejected: number } {
  const written = round.findings.filter(
    (finding) => finding.carried_from === undefined && !finding.verdict?.out_of_scope && (finding.severity === 'blocking' || finding.degraded),
  );
  return { reported: written.length, rejected: written.filter((finding) => finding.verdict?.status === 'rejected').length };
}

function ids(findings: FindingRecord[]): string {
  return findings.map((finding) => finding.id).join(', ');
}
