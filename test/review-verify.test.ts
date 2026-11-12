import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fingerprint, parseReview, type Finding } from '../src/review/findings.js';
import { assertUniqueRuleIds, decisionIds, inactiveRules, ruleCollisions } from '../src/review/rules.js';
import { sessionSkills } from '../src/skills/stage.js';
import { citedPath, countQuote, verifyReport, type Evidence } from '../src/review/verify.js';
import { QUOTED_FILE, tmpDir, write } from './helpers.js';

const CART = QUOTED_FILE.content;

describe('quote near file:line', () => {
  it('finds a quote regardless of indentation and line breaks, also across lines', () => {
    expect(countQuote(CART, 5, 'total += amount;')).toBe(1);
    expect(countQuote(CART, 4, 'void addItems(long amount) {\n total   += amount;')).toBe(1);
    expect(countQuote(CART, 4, 'void addItems(long amount) { total += amount; }')).toBe(1);
  });

  it('a quote must start within 5 lines of the cited line', () => {
    const padded = [...Array.from({ length: 20 }, (_unused, index) => `// line ${index + 1}`), 'int target;'].join('\n');
    expect(countQuote(padded, 16, 'int target;')).toBe(1);
    expect(countQuote(padded, 15, 'int target;')).toBe(0);
    expect(countQuote(padded, 21, '// line 16')).toBe(1);
    expect(countQuote(padded, 21, '// line 15')).toBe(0);
  });

  it('counts every place the quote starts in the window, and nothing for a line past the end', () => {
    expect(countQuote(CART, 3, 'total')).toBe(2);
    expect(countQuote(CART, 40, 'total')).toBe(0);
    expect(countQuote(CART, 2, '   ')).toBe(0);
  });

  it('a cited path stays inside the repo', () => {
    expect(citedPath('./src/Cart.java')).toBe('src/Cart.java');
    expect(citedPath('src\\Cart.java')).toBe('src/Cart.java');
    for (const outside of ['../secrets.txt', '/etc/passwd', 'src/../../x', '.']) expect(citedPath(outside)).toBeUndefined();
  });
});

describe('verifying a review report', () => {
  const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
    acceptance: ['AC-1', 'AC-2'],
    specSections: ['Spec: limit koszyka', 'Decisions', 'Contracts'],
    ruleIds: new Set(['AG-TQ-01', 'ARCH-01']),
    read: async (file) => (file === 'src/Cart.java' ? CART : undefined),
    ...overrides,
  });
  const blocking = (id: string, overrides: Partial<Finding> = {}): Record<string, unknown> => ({
    id,
    severity: 'blocking',
    message: 'm',
    file: 'src/Cart.java',
    line: 5,
    weight: 'medium',
    impact: 'x',
    quote: 'total += amount;',
    basis: { type: 'spec', ref: 'AC-1' },
    ...overrides,
  });
  const report = (findings: unknown[]) => parseReview(JSON.stringify({ contract: 1, coverage: { rules: [], tests: [] }, findings }), 'standards');
  const byId = (findings: Finding[], id: string) => findings.find((finding) => finding.id === id)!;

  it('a basis that does not exist downgrades to nit; a quote that is not there rejects', async () => {
    const { report: verified, ambiguous } = await verifyReport(
      report([
        blocking('OK'),
        blocking('RULE', { basis: { type: 'standard', ref: 'ARCH-01' } }),
        blocking('SECTION', { basis: { type: 'spec', ref: 'spec:contracts' } }),
        blocking('NO-AC', { basis: { type: 'spec', ref: 'AC-9' } }),
        blocking('NO-RULE', { basis: { type: 'standard', ref: 'SEC-07' } }),
        blocking('NO-SECTION', { basis: { type: 'spec', ref: 'spec:Rollout' } }),
        blocking('NO-QUOTE', { quote: 'total -= amount;' }),
        blocking('NO-FILE', { file: 'src/Ghost.java' }),
        blocking('OUTSIDE', { file: '../other/Cart.java' }),
      ]),
      evidence(),
      { lastAttempt: false },
    );
    expect(verified.blocking.map((finding) => finding.id)).toEqual(['OK', 'RULE', 'SECTION']);
    expect(byId(verified.findings, 'OK').verdict).toEqual({ status: 'confirmed' });
    for (const id of ['NO-AC', 'NO-RULE', 'NO-SECTION']) {
      expect(byId(verified.findings, id)).toMatchObject({ severity: 'nit', verdict: { status: 'rejected' } });
    }
    expect(byId(verified.findings, 'NO-AC').degraded).toMatch(/AC-9 does not exist/);
    expect(byId(verified.findings, 'NO-RULE').degraded).toMatch(/SEC-07/);
    expect(byId(verified.findings, 'NO-QUOTE')).toMatchObject({ severity: 'blocking', verdict: { status: 'rejected', reason: expect.stringMatching(/does not occur/) } });
    expect(byId(verified.findings, 'NO-FILE').verdict?.reason).toMatch(/does not exist in the reviewed commit/);
    expect(byId(verified.findings, 'OUTSIDE').verdict?.reason).toMatch(/leaves the repo/);
    expect(ambiguous).toEqual([]);
  });

  it('an ambiguous quote goes back to the reviewer once; on the last attempt it is rejected', async () => {
    const findings = report([blocking('TWICE', { line: 3, quote: 'total' })]);
    const first = await verifyReport(findings, evidence(), { lastAttempt: false });
    expect(first.ambiguous.map((finding) => finding.id)).toEqual(['TWICE']);
    const last = await verifyReport(findings, evidence(), { lastAttempt: true });
    expect(last.ambiguous).toEqual([]);
    expect(last.report.blocking).toEqual([]);
    expect(last.report.findings[0]!.verdict?.reason).toMatch(/matches 2 places/);
  });

  it('a spec section needs a spec; nits and the spec axis’s own findings are left alone', async () => {
    const coverage = [{ ref: 'AC-2', verdict: 'unmet', evidence: 'no endpoint' }];
    const specReport = parseReview(
      JSON.stringify({ contract: 1, coverage, findings: [blocking('SECTION', { basis: { type: 'spec', ref: 'spec:Decisions' } }), { id: 'N', severity: 'nit', message: 'n' }] }),
      'spec',
      ['AC-2'],
    );
    const { report: verified } = await verifyReport(specReport, evidence({ specSections: undefined }), { lastAttempt: true });
    expect(byId(verified.findings, 'SECTION').degraded).toMatch(/has no spec\.md/);
    expect(byId(verified.findings, 'N').verdict).toBeUndefined();
    expect(verified.blocking.map((finding) => finding.id)).toEqual(['COV-AC-2']);
  });

  it('a section is found by its own words or its parent heading, as reviewers paraphrase the path', async () => {
    const specSections = ['Contracts', '`library.catalog` — facade (additions)', 'Decisions', 'API'];
    const { report: verified } = await verifyReport(
      report([
        blocking('CHILD', { basis: { type: 'spec', ref: 'spec:Contracts — facade (additions)' } }),
        blocking('BULLET', { basis: { type: 'spec', ref: 'spec:Decisions — Natural title order' } }),
        blocking('NO-SECTION', { basis: { type: 'spec', ref: 'spec:Rollout — rapid deploy' } }),
      ]),
      evidence({ specSections }),
      { lastAttempt: true },
    );
    expect(verified.blocking.map((finding) => finding.id)).toEqual(['CHILD', 'BULLET']);
    expect(byId(verified.findings, 'NO-SECTION').degraded).toMatch(/no such section/);
  });

  it('reads each cited file once', async () => {
    const reads: string[] = [];
    const read = async (file: string) => (reads.push(file), CART);
    await verifyReport(report([blocking('A'), blocking('B', { line: 2, quote: 'long total;' })]), evidence({ read }), { lastAttempt: true });
    expect(reads).toEqual(['src/Cart.java']);
  });
});

describe('fingerprint with the quote', () => {
  const finding = (quote: string): Finding => ({ id: 'F', severity: 'blocking', message: 'm', file: 'A.java', basis: { type: 'standard', ref: 'AG-TQ-01' }, quote });

  it('two places breaking one rule in a file are two findings; reformatting the quote is not', () => {
    expect(fingerprint(finding('assertTrue(result)'))).not.toBe(fingerprint(finding('assertTrue(other)')));
    expect(fingerprint(finding('if (a) {\n  b();'))).toBe(fingerprint(finding('if (a) { b();')));
  });
});

describe('rule ids', () => {
  const config = (stages: Record<string, unknown> = {}) => deepMerge(DEFAULTS, { stages }) as AgenticConfig;

  it('an id defined twice is a collision, with both sources named', () => {
    expect(ruleCollisions([{ name: 'a.md', text: '- **ARCH-01 One.**' }, { name: 'b.md', text: '- **ARCH-01 Other.**\n- **ARCH-02 X.**' }])).toEqual(['ARCH-01: a.md, b.md']);
  });

  it('an ADR of the repo is a citable decision: ADR-0004 from docs/adr/0004-….md', () => {
    const repo = tmpDir();
    write(repo, path.join('docs', 'adr', '0004-four-bounded-contexts.md'), '# 4. Four bounded contexts\n');
    write(repo, path.join('docs', 'adr', 'ADR-0012-first-login.md'), '# First login\n');
    write(repo, path.join('docs', 'adr', 'README.md'), '# Decisions\n');
    expect([...decisionIds(repo)].sort()).toEqual(['ADR-0004', 'ADR-0012']);
    expect([...decisionIds(tmpDir())]).toEqual([]);
  });

  it('the framework skills alone have no collisions', () => {
    expect(() => assertUniqueRuleIds(config(), tmpDir())).not.toThrow();
  });

  it('the AG- prefix belongs to the framework: a repo standard or repo skill using it fails the flow start', () => {
    const repo = tmpDir();
    write(repo, path.join('.agentic', 'standards', 'testing.md'), '- **AG-TQ-09 Our own rule.** …\n');
    expect(() => assertUniqueRuleIds(config(), repo)).toThrow(/reserved[\s\S]*AG-TQ-09: \.agentic\/standards\/testing\.md/);

    const skill = tmpDir();
    write(skill, path.join('.agentic', 'skills', 'ours', 'SKILL.md'), '---\nname: ours\n---\n- **AG-OURS-01 Ours.** …\n');
    expect(() => assertUniqueRuleIds(config({ implement: { skills: ['repo:ours'] } }), skill)).toThrow(/AG-OURS-01: skill repo:ours/);
  });

  it('a team may name its own rules CODE-nn: framework rules carry AG-', () => {
    const repo = tmpDir();
    write(repo, path.join('.agentic', 'standards', 'code.md'), '- **CODE-01 Our naming.** …\n');
    expect(() => assertUniqueRuleIds(config(), repo)).not.toThrow();
  });

  it('a repo standard reusing an id fails the flow start; a repo skill too', () => {
    const other = tmpDir();
    write(other, path.join('.agentic', 'standards', 'arch.md'), '- **ARCH-01 Layers.** …\n');
    write(other, path.join('.agentic', 'skills', 'layers', 'SKILL.md'), '---\nname: layers\n---\n- **ARCH-01 Also layers.** …\n');
    expect(() => assertUniqueRuleIds(config({ 'review-standards': { skills: ['repo:layers'] } }), other)).toThrow(/ARCH-01/);
  });
});

describe('switching skills and rules off', () => {
  const config = (layer: Record<string, unknown>) => deepMerge(DEFAULTS, layer) as AgenticConfig;

  it('skills.disabled drops a practice skill from every stage; the stage skill stays', () => {
    const off = config({ skills: { disabled: ['agentic-clean-code', 'agentic-implement'] } });
    expect(sessionSkills(off, 'implement')).toEqual(['agentic-implement', 'agentic-test-quality']);
    expect(sessionSkills(off, 'review-standards')).toEqual(['agentic-review-standards', 'agentic-test-quality']);
  });

  it('rules.disabled and Checked by: make a rule inactive; without repo checks a checked-by rule stays with the reviewer', () => {
    const sources = [{ name: 'arch.md', text: '- **ARCH-01 Layers.** Domain imports nothing.\n  _Checked by:_ ArchUnit\n- **ARCH-02 Ports.** …\n' }];
    const withChecks = config({ rules: { disabled: ['AG-CODE-03'] }, review: { checks: ['./gradlew test'] } });
    expect(Object.fromEntries(inactiveRules(withChecks, sources))).toEqual({ 'ARCH-01': 'checked-by', 'AG-CODE-03': 'rules.disabled' });
    expect([...inactiveRules(config({ review: { checks: 'none' } }), sources).keys()]).toEqual([]);
  });

  it('a finding citing an inactive rule is downgraded with the reason', async () => {
    const parsed = parseReview(
      JSON.stringify({
        contract: 1,
        coverage: { rules: [], tests: [] },
        findings: [{ id: 'OFF', severity: 'blocking', message: 'm', file: 'src/Cart.java', line: 5, weight: 'medium', impact: 'x', quote: 'total += amount;', basis: { type: 'standard', ref: 'AG-CODE-03' } }],
      }),
      'standards',
    );
    const { report: verified } = await verifyReport(
      parsed,
      { acceptance: [], ruleIds: new Set(), inactiveRules: new Map([['AG-CODE-03', 'rules.disabled']]), read: async () => CART },
      { lastAttempt: true },
    );
    expect(verified.findings[0]).toMatchObject({ severity: 'nit', degraded: expect.stringMatching(/AG-CODE-03 is off \(rules.disabled/) });
  });
});
