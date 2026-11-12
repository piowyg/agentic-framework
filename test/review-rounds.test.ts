import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, type Finding } from '../src/review/findings.js';
import { loadState, newState, openFindings, reviewSummary, roundRecord, saveState, type GroupState } from '../src/orchestrator/state.js';
import { tmpDir } from './helpers.js';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'F1',
  severity: 'blocking',
  message: 'Missing validation of the amount',
  file: 'src/Transfer.java',
  line: 10,
  basis: { type: 'standard', ref: 'ARCH-01' },
  ...overrides,
});

describe('finding fingerprint', () => {
  it('ignores the line and the wording when the finding cites a rule or AC', () => {
    expect(fingerprint(finding({ line: 42, message: 'Amount is not validated' }))).toBe(fingerprint(finding()));
  });

  it('tells apart findings in another file or citing another rule', () => {
    expect(fingerprint(finding({ file: 'src/Other.java' }))).not.toBe(fingerprint(finding()));
    expect(fingerprint(finding({ basis: { type: 'standard', ref: 'ARCH-02' } }))).not.toBe(fingerprint(finding()));
  });

  it('falls back to the normalized scenario or message when there is no ref', () => {
    const defect = (scenario: string) => finding({ basis: { type: 'defect', scenario } });
    expect(fingerprint(defect('Negative amount → transfer accepted.'))).toBe(fingerprint(defect('negative amount  transfer accepted')));
    expect(fingerprint(defect('Negative amount → transfer accepted'))).not.toBe(fingerprint(defect('Zero amount → transfer accepted')));
  });
});

describe('review round history', () => {
  const group = (rounds: ReturnType<typeof roundRecord>[]): GroupState => ({ status: 'running', tasks: {}, review: { rounds } });

  it('open findings come from the last round only and skip rejected ones', () => {
    const first = roundRecord(1, { spec: { findings: [finding({ id: 'OLD' })], blocking: [] } });
    const second = roundRecord(2, {
      standards: { findings: [finding({ id: 'A' }), finding({ id: 'B', file: 'B.java' }), finding({ id: 'N', severity: 'nit' })], blocking: [] },
    });
    second.findings[1]!.verdict = { status: 'rejected', reason: 'quote not found' };
    expect(openFindings(group([first, second])).map((open) => open.id)).toEqual(['A']);
    expect(reviewSummary(group([first, second]))).toBe('rounds 2, open blocking 1, nits 1, rejected 1');
  });

  it('migrates v1 counters into a single migrated round and renames in-progress report keys', () => {
    const workDir = path.join(tmpDir(), 'flow');
    saveState(workDir, newState({ slug: 'flow', title: 'Flow', entry: 'new', origin: { repoRoot: '/repo' } }));
    const file = path.join(workDir, 'state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.version = 1;
    raw.cwd = '/repo';
    delete raw.origin;
    raw.groups = {
      g1: { status: 'running', tasks: {}, review: { rounds: 2, blocking: 1, nits: 3, open: [finding()] }, round_reports: { round: 3, reports: { 'review-spec': { findings: [], blocking: [] } } } },
      g2: { status: 'pending', tasks: {} },
    };
    fs.writeFileSync(file, JSON.stringify(raw));

    const state = loadState(workDir);
    const migrated = state.groups.g1!;
    expect(migrated.review!.rounds).toEqual([
      { round: 2, finished_at: raw.updated_at, findings: [{ ...finding(), fingerprint: fingerprint(finding()) }], migrated: true },
    ]);
    expect(openFindings(migrated)).toHaveLength(1);
    expect(Object.keys(migrated.round_reports!.reports)).toEqual(['spec']);
    expect(state.groups.g2).toEqual({ status: 'pending', tasks: {} });
  });
});
