// Mechanical verification of blocking findings, no tokens: the basis exists, the quote
// is at `file:line`. A rejected finding stays in the report for the gate; only open ones reach the fixer.

import path from 'node:path';
import { isOpen, normalizeCode, type Finding, type ReviewReport } from './findings.js';
import type { InactiveReason } from './rules.js';

/** How far from `line` a quote may start. */
export const QUOTE_RADIUS = 5;

/** What a finding is checked against, read before the review session so it can't shape it. */
export interface Evidence {
  /** Acceptance criteria of the ticket. */
  acceptance: string[];
  /** Headings of `spec.md`; absent without a spec. */
  specSections?: string[];
  /** Rule ids of the repo standards and the axis's skills, and the repo's ADRs (`ADR-0004`), without the inactive ones. */
  ruleIds: ReadonlySet<string>;
  /** Rules switched off (`rules.disabled`) or left to the repo checks (`Checked by:`). */
  inactiveRules?: ReadonlyMap<string, InactiveReason>;
  /** A file of the reviewed commit; undefined when it isn't there. */
  read(file: string): Promise<string | undefined>;
}

export interface Verification {
  report: ReviewReport;
  /** Blocking findings whose quote matches more than one place near their line. */
  ambiguous: Finding[];
}

/**
 * Each blocking finding a reviewer wrote is checked: a basis that doesn't exist downgrades it to nit, a quote not found
 * near its line rejects it. An ambiguous quote is left for the reviewer to lengthen, unless this is the last attempt.
 */
export async function verifyReport(report: ReviewReport, evidence: Evidence, options: { lastAttempt: boolean }): Promise<Verification> {
  const files = new Map<string, string | undefined>();
  const read = async (file: string) => {
    if (!files.has(file)) files.set(file, await evidence.read(file));
    return files.get(file);
  };
  const ambiguous: Finding[] = [];
  const findings: Finding[] = [];
  // one at a time: each read is a command in the clone's workspace
  for (const finding of report.findings) {
    const verified = await verifyFinding(finding, evidence, read);
    if (verified.ambiguous && !options.lastAttempt) ambiguous.push(finding);
    findings.push(verified.finding);
  }
  return { report: { ...report, findings, blocking: findings.filter(isOpen) }, ambiguous };
}

async function verifyFinding(
  written: Finding,
  evidence: Evidence,
  read: (file: string) => Promise<string | undefined>,
): Promise<{ finding: Finding; ambiguous?: true }> {
  const finding = asDefect(written, evidence);
  // without a file it's the orchestrator's own finding (an AC the spec axis judged undelivered)
  if (finding.severity !== 'blocking' || !finding.file) return { finding: written };
  const unknownBasis = unknownBasisReason(finding, evidence);
  if (unknownBasis) return { finding: { ...finding, severity: 'nit', degraded: unknownBasis, verdict: { status: 'rejected', reason: unknownBasis } } };
  const rejected = (reason: string) => ({ ...finding, verdict: { status: 'rejected' as const, reason } });
  const where = `${finding.file}:${finding.line} (±${QUOTE_RADIUS} lines)`;
  const file = citedPath(finding.file);
  if (!file) return { finding: rejected(`path ${finding.file} leaves the repo`) };
  const content = await read(file);
  if (content === undefined) return { finding: rejected(`${finding.file} does not exist in the reviewed commit`) };
  const matches = countQuote(content, finding.line!, finding.quote ?? '');
  if (matches === 0) return { finding: rejected(`the quote does not occur in ${where}`) };
  if (matches > 1) return { finding: rejected(`the quote matches ${matches} places in ${where}`), ambiguous: true };
  return { finding: { ...finding, verdict: { status: 'confirmed' } } };
}

/**
 * A rule from outside the repo (`CWE-89`, `OWASP A03`) with a concrete scenario is a defect claim: judged as one,
 * not downgraded for an unknown rule — a security reviewer reaches for such ids.
 */
function asDefect(finding: Finding, evidence: Evidence): Finding {
  const { basis } = finding;
  const ref = basis?.ref ?? '';
  if (basis?.type !== 'standard' || !basis.scenario?.trim() || evidence.ruleIds.has(ref) || evidence.inactiveRules?.has(ref)) return finding;
  return { ...finding, basis: { ...basis, type: 'defect' } };
}

function unknownBasisReason(finding: Finding, evidence: Evidence): string | undefined {
  const ref = finding.basis?.ref ?? '';
  if (finding.basis?.type === 'spec') {
    if (/^AC-\d+$/.test(ref)) return evidence.acceptance.includes(ref) ? undefined : `${ref} does not exist in the ticket`;
    if (!evidence.specSections) return `${ref}: the flow has no spec.md`;
    const section = ref.replace(/^spec:?/, '').trim();
    if (section && !evidence.specSections.some((heading) => namesSection(section, heading))) return `${ref}: no such section in spec.md`;
  }
  const inactive = finding.basis?.type === 'standard' ? evidence.inactiveRules?.get(ref) : undefined;
  if (inactive) return `rule ${ref} is off (${inactive === 'checked-by' ? 'the repo checks enforce it' : 'rules.disabled in the config'})`;
  if (finding.basis?.type === 'standard' && !evidence.ruleIds.has(ref)) return `rule ${ref} exists neither in the repo standards nor in the axis skills`;
  return undefined;
}

/**
 * A reviewer writes a section as a path (`Contracts — facade (additions)`) or names a bullet under a heading
 * (`Decisions — Natural title order`): a part of the path that is a heading, or a heading's whole words, names it.
 */
function namesSection(section: string, heading: string): boolean {
  const parts = section.split(/\s+[—–>›/|-]\s+/).map(words).filter(Boolean);
  const title = words(heading);
  return parts.some((part) => containsWords(title, part) || containsWords(part, title));
}

/** Lowercase words, without backticks and punctuation. */
function words(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function containsWords(text: string, part: string): boolean {
  return part !== '' && ` ${text} `.includes(` ${part} `);
}

/** A path relative to the repo root, or undefined when it points outside it. */
export function citedPath(file: string): string | undefined {
  const normalized = path.posix.normalize(file.replaceAll('\\', '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return undefined;
  return normalized;
}

/**
 * How many times the quote starts within `radius` lines of `line` (1-based). Whitespace is normalized, so
 * indentation and line breaks don't matter and a quote may span lines.
 */
export function countQuote(content: string, line: number, quote: string, radius = QUOTE_RADIUS): number {
  const needle = normalizeCode(quote);
  const lines = content.split('\n');
  const first = Math.max(1, line - radius);
  const last = Math.min(lines.length, line + radius);
  if (!needle || first > last) return 0;
  // the text from the window's first line to the end of the file, and where the window's last line ends in it
  let text = '';
  let windowEnd = 0;
  for (let index = first; index <= lines.length; index++) {
    const part = normalizeCode(lines[index - 1]!);
    if (part) text += (text ? ' ' : '') + part;
    if (index === last) windowEnd = text.length;
  }
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1 && at < windowEnd; at = text.indexOf(needle, at + 1)) count++;
  return count;
}
