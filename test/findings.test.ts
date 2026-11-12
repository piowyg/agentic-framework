import { describe, expect, it } from 'vitest';
import { parseReview } from '../src/review/findings.js';

const report = (findings: unknown[], coverage: unknown = { rules: [], tests: [] }) => JSON.stringify({ contract: 1, coverage, findings });
const calibrated = { weight: 'medium', impact: 'x', quote: 'x' };

describe('review report', () => {
  it('blocking without basis, file:line or calibration is downgraded to nit', () => {
    const parsed = parseReview(
      report([
        { id: 'A', severity: 'blocking', message: 'x', file: 'A.java', line: 3, ...calibrated, basis: { type: 'standard', ref: 'ARCH-01' } },
        { id: 'B', severity: 'blocking', message: 'gust', file: 'A.java', line: 5, ...calibrated },
        { id: 'C', severity: 'blocking', message: 'N+1', file: 'R.java', line: 9, ...calibrated, basis: { type: 'defect', scenario: '100 kont → 101 zapytań' } },
        { id: 'D', severity: 'blocking', message: '?', ...calibrated, basis: { type: 'spec', ref: 'AC-1' } },
        { id: 'E', severity: 'nit', message: 'nazwa' },
        { id: 'F', severity: 'blocking', message: 'x', file: 'A.java', line: 3, ...calibrated, weight: 'low', basis: { type: 'spec', ref: 'AC-1' } },
        { id: 'G', severity: 'blocking', message: 'x', file: 'A.java', line: 3, weight: 'high', quote: 'x', basis: { type: 'spec', ref: 'AC-1' } },
        { id: 'H', severity: 'blocking', message: 'x', file: 'A.java', line: 3, weight: 'high', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } },
      ]),
      'standards',
    );
    expect(parsed.blocking.map((finding) => finding.id)).toEqual(['A', 'C']);
    const degraded = (id: string) => parsed.findings.find((finding) => finding.id === id)!.degraded;
    expect(degraded('B')).toMatch(/basis/);
    expect(degraded('D')).toMatch(/file/);
    expect(degraded('F')).toMatch(/low/);
    expect(degraded('G')).toMatch(/impact/);
    expect(degraded('H')).toMatch(/quote/);
  });

  it('rejects anything but the contract: invalid JSON, another version, a schema violation', () => {
    expect(() => parseReview('wszystko ok!', 'standards')).toThrow(/invalid JSON/);
    expect(() => parseReview(JSON.stringify({ contract: 2, coverage: { rules: [], tests: [] }, findings: [] }), 'standards')).toThrow(/contract version/);
    expect(() => parseReview(report([null]), 'standards')).toThrow(/findings\[0\]/);
    expect(() => parseReview(report([{ severity: 'Blocking', message: 'x' }]), 'standards')).toThrow(/severity/);
    expect(() => parseReview(JSON.stringify({ contract: 1, findings: [] }), 'standards')).toThrow(/coverage/);
  });

  it('the spec axis assesses every acceptance criterion in scope', () => {
    const coverage = [{ ref: 'AC-1', verdict: 'met', evidence: 'CartTest' }];
    expect(parseReview(report([], coverage), 'spec', ['AC-1']).coverage).toEqual(coverage);
    expect(() => parseReview(report([], coverage), 'spec', ['AC-1', 'AC-2'])).toThrow(/no verdict for AC-2/);
  });

  it('an unmet or partial criterion blocks even when its finding was downgraded or never written', () => {
    const coverage = [
      { ref: 'AC-1', verdict: 'met', evidence: 'CartTest' },
      { ref: 'AC-2', verdict: 'unmet', evidence: 'no paging endpoint' },
      { ref: 'AC-3', verdict: 'partial', evidence: 'no cursor' },
    ];
    const anchored = { id: 'S1', severity: 'blocking', message: 'x', file: 'A.java', line: 3, ...calibrated, basis: { type: 'spec', ref: 'AC-3' } };
    const unanchored = { id: 'S2', severity: 'blocking', message: 'missing', ...calibrated, basis: { type: 'spec', ref: 'AC-2' } };
    const parsed = parseReview(report([anchored, unanchored], coverage), 'spec', ['AC-1', 'AC-2', 'AC-3']);
    expect(parsed.blocking.map((finding) => finding.id)).toEqual(['S1', 'COV-AC-2']);
    expect(parsed.blocking[1]).toMatchObject({ basis: { type: 'spec', ref: 'AC-2' }, message: 'AC-2 unmet: no paging endpoint' });
  });

  it('coverage has the shape of its axis', () => {
    expect(() => parseReview(report([], { rules: [] }), 'security')).toThrow(/boundaries/);
    expect(parseReview(report([], { boundaries: ['POST /cart/items'] }), 'security').findings).toEqual([]);
    expect(parseReview(report([], { checked: ['contracts g1 ↔ g2'] }), 'final').findings).toEqual([]);
  });

  it('spec_issue is carried over; blank counts as none', () => {
    const withIssue = JSON.stringify({ contract: 1, coverage: { rules: [], tests: [] }, findings: [], spec_issue: 'AC-1 sprzeczne z AC-2' });
    expect(parseReview(withIssue, 'standards').specIssue).toBe('AC-1 sprzeczne z AC-2');
    expect(parseReview(JSON.stringify({ contract: 1, coverage: { rules: [], tests: [] }, findings: [], spec_issue: ' ' }), 'standards').specIssue).toBeUndefined();
  });
});
