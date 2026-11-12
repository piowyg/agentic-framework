// A reviewer's report: `out/review-<axis>.json` (contract in src/contracts/schemas.ts).

import { createHash } from 'node:crypto';
import { parseJsonArtifact, reviewSchema } from '../contracts/index.js';
import { ArtifactError } from '../orchestrator/artifacts.js';
import type { ScopeAxis } from '../orchestrator/state.js';
import { RULE_ID } from './rule-id.js';
import type { PreviousVerdict } from './scope.js';

export type Severity = 'blocking' | 'nit';
export type Weight = 'high' | 'medium' | 'low';
export type BasisType = 'spec' | 'standard' | 'defect';

/** Outcome of the mechanical verification; absent until verification runs. */
export interface FindingVerdict {
  status: 'confirmed' | 'rejected';
  reason?: string;
  /** Rejected by the frozen scope of round 2+, not by the evidence: not noise for `rejection_rate`. */
  out_of_scope?: true;
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  /** spec → AC/section id; standard → rule id (ARCH-01); defect → input → wrong-result scenario. */
  basis?: { type: BasisType; ref?: string; scenario?: string };
  file?: string;
  line?: number;
  weight?: Weight;
  /** What breaks, for whom, how easily. */
  impact?: string;
  /** Verbatim code at `file:line`, found there by the orchestrator (src/review/verify.ts). */
  quote?: string;
  /** Why a blocking finding without a valid basis was downgraded to nit. */
  degraded?: string;
  /** A rejected blocking finding goes to the gate report, not to the fixer. */
  verdict?: FindingVerdict;
  /** An open finding of that round the reviewer judged not fixed, carried as it was. */
  carried_from?: number;
}

export interface ReviewReport {
  findings: Finding[];
  /** Blocking findings verification didn't reject. */
  blocking: Finding[];
  /** What the axis checked, even with no findings; shape per axis. */
  coverage?: unknown;
  specIssue?: string;
  /** Round 2+: verdicts on the previous round's open findings (src/review/scope.ts). */
  previous?: PreviousVerdict[];
}

/**
 * Identity of a finding across rounds. Line numbers shift after a fix, so they are left out; a rule or AC id
 * identifies the problem better than the reviewer's wording, which changes between rounds. The quoted code
 * tells apart two places in one file that break the same rule.
 */
export function fingerprint(finding: Finding): string {
  const ref = finding.basis?.ref?.trim();
  const subject = ref || normalizeText(finding.basis?.scenario || finding.message);
  const key = [finding.file ?? '', finding.basis?.type ?? '', subject, normalizeCode(finding.quote ?? '')].join('\u0000');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Code compared regardless of indentation and line breaks. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}

/** A blocking finding still open: verification didn't reject it. */
export function isOpen(finding: Finding): boolean {
  return finding.severity === 'blocking' && finding.verdict?.status !== 'rejected';
}

type RawFinding = Omit<Finding, 'id' | 'degraded'> & { id?: string };

interface RawReport {
  coverage: unknown;
  findings: RawFinding[];
  spec_issue?: string;
  previous?: PreviousVerdict[];
}

/**
 * Schema and version first, then the checks a schema can't express: the spec axis covers every AC of the scope.
 * A blocking finding without what calibration needs is downgraded, not rejected.
 */
export function parseReview(text: string, axis: ScopeAxis, acceptance: string[] = []): ReviewReport {
  const artifact = `review-${axis}.json`;
  const raw = parseJsonArtifact<RawReport>(text, reviewSchema(axis), artifact);
  if (axis === 'spec' && acceptance.length) {
    const covered = (raw.coverage as Array<{ ref: string }>).map((entry) => entry.ref);
    const missing = acceptance.filter((id) => !covered.includes(id));
    if (missing.length) throw new ArtifactError(artifact, [`coverage: no verdict for ${missing.join(', ')}`]);
  }
  const reported = raw.findings.map((finding, index) => normalize(finding, index));
  const findings = axis === 'spec' ? [...reported, ...undeliveredCriteria(raw.coverage as SpecCoverage, reported)] : reported;
  return {
    findings,
    blocking: findings.filter(isOpen),
    coverage: raw.coverage,
    specIssue: raw.spec_issue?.trim() || undefined,
    ...(raw.previous && { previous: raw.previous }),
  };
}

type SpecCoverage = Array<{ ref: string; verdict: 'met' | 'unmet' | 'partial'; evidence: string }>;

/**
 * An AC the reviewer judged unmet or partial blocks even without a finding: missing code has no line to quote,
 * so its finding would be downgraded and the scope would pass without the criterion.
 */
function undeliveredCriteria(coverage: SpecCoverage, findings: Finding[]): Finding[] {
  const blocked = new Set(findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.basis?.ref));
  return coverage
    .filter((entry) => entry.verdict !== 'met' && !blocked.has(entry.ref))
    .map((entry) => ({
      id: `COV-${entry.ref}`,
      severity: 'blocking',
      weight: 'high',
      basis: { type: 'spec', ref: entry.ref },
      impact: `${entry.ref} is not delivered`,
      message: `${entry.ref} ${entry.verdict}: ${entry.evidence}`,
    }));
}

function normalize(raw: RawFinding, index: number): Finding {
  const finding: Finding = { ...raw, id: raw.id ?? `F${index + 1}` };
  if (finding.severity === 'blocking') {
    const why = missingBasis(finding) ?? missingCalibration(finding);
    if (why) Object.assign(finding, { severity: 'nit', degraded: why });
  }
  return finding;
}

function missingBasis(finding: Finding): string | undefined {
  if (!finding.file || finding.line === undefined) return 'no `file` + `line`';
  const basis = finding.basis;
  if (!basis) return 'no `basis.type` (spec | standard | defect)';
  if (basis.type === 'spec' && !/^AC-\d+$|^spec(:|$)/.test(basis.ref ?? '')) return 'basis spec without `ref` (AC-n or spec:<section>)';
  if (basis.type === 'standard' && !new RegExp(`^${RULE_ID}$`).test(basis.ref ?? '')) return 'basis standard without a rule ID (e.g. ARCH-01)';
  if (basis.type === 'defect' && !String(basis.scenario ?? '').trim()) return 'basis defect without `scenario`';
  return undefined;
}

function missingCalibration(finding: Finding): string | undefined {
  if (finding.weight !== 'high' && finding.weight !== 'medium') return finding.weight === 'low' ? 'weight `low` = nit' : 'no `weight` (high | medium)';
  if (!finding.impact?.trim()) return 'no `impact`';
  if (!finding.quote?.trim()) return 'no `quote`';
  return undefined;
}
