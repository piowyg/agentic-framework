// Frozen scope of a review round 2+: the reviewer judges what the fixer changed since
// the previous round — whether the open findings were fixed, and regressions in the changed lines. Nothing else.

import { fingerprint, isOpen, type Finding, type ReviewReport } from './findings.js';

/** How far from a changed line a new finding may point (git's default context; a deletion leaves no line to hit). */
export const SCOPE_MARGIN = 3;

/** Changed line ranges on the new side, per file. */
export type ChangedLines = Map<string, Array<[number, number]>>;

/** The reviewer's verdict on an open finding of the previous round. */
export interface PreviousVerdict {
  id: string;
  status: 'fixed' | 'not_fixed';
}

export interface FrozenScope {
  /** The round whose commit the diff starts at. */
  sinceRound: number;
  /** Open findings of that round on this axis. */
  previous: Finding[];
  changed: ChangedLines;
  /** Fingerprints of findings set aside: a re-report is left to the loop to filter, not rejected. */
  setAside: ReadonlySet<string>;
}

/** Hunks of `git diff -U0`: `+++ b/<path>` names the file, `@@ -a,b +c,d @@` the new-side range. */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^"(.*)"$/, '$1');
      file = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // a pure deletion has no new lines: it sits right after line `start`
    const range: [number, number] = count === 0 ? [start, start + 1] : [start, start + count - 1];
    changed.set(file, [...(changed.get(file) ?? []), range]);
  }
  return changed;
}

export function inChangedLines(finding: Finding, changed: ChangedLines, margin = SCOPE_MARGIN): boolean {
  if (!finding.file || finding.line === undefined) return false;
  const line = finding.line;
  return (changed.get(finding.file) ?? []).some(([first, last]) => line >= first - margin && line <= last + margin);
}

/**
 * Open findings of the previous round the reviewer judged not fixed come back as they were (same fingerprint);
 * without a verdict they count as not fixed. A new blocking finding outside the changed lines that isn't a re-report
 * is rejected as out of scope — it doesn't count as noise (`rejection_rate`), the gate lists it separately.
 */
export function applyFrozenScope(report: ReviewReport, verdicts: PreviousVerdict[], scope: FrozenScope): ReviewReport {
  const fixed = new Set(verdicts.filter((verdict) => verdict.status === 'fixed').map((verdict) => verdict.id));
  const carried = scope.previous.filter((finding) => !fixed.has(finding.id));
  const previousPrints = new Set(scope.previous.map(fingerprint));
  const carriedPrints = new Set(carried.map(fingerprint));
  const carriedIds = new Set(carried.map((finding) => finding.id));
  const reported = report.findings.flatMap((found): Finding[] => {
    const print = fingerprint(found);
    if (carriedPrints.has(print)) return [];
    // ids are numbered per report: a new `F1` next to a carried `F1` would make the fixer's answer ambiguous
    const finding = carriedIds.has(found.id) ? { ...found, id: `r${scope.sinceRound + 1}-${found.id}` } : found;
    if (!isOpen(finding) || previousPrints.has(print) || scope.setAside.has(print) || inChangedLines(finding, scope.changed)) return [finding];
    const reason = `out of scope: round ${scope.sinceRound + 1} judges only changes since round ${scope.sinceRound} (±${SCOPE_MARGIN} lines)`;
    return [{ ...finding, verdict: { status: 'rejected', reason, out_of_scope: true } }];
  });
  const findings = [...carried.map((finding) => ({ ...finding, carried_from: scope.sinceRound })), ...reported];
  return { ...report, findings, blocking: findings.filter(isOpen) };
}
