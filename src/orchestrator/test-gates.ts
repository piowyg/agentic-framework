import type { WriteTestsArtifact } from '../contracts/schemas.js';
import { describeFailures, passed, rerunFailed, runChecks, type CheckRun, type ChecksScope } from './checks.js';
import type { FlowRun } from './run.js';
import { caseKey, casesOf, casesOfFile, clearReports, readReports, type TestCase } from './test-reports.js';

/** One run of the tests: `review.compile`, then the commands, then the JUnit reports they left. */
export interface TestRun {
  /** Absent without `review.compile`. */
  compile?: CheckRun;
  /** Empty when the compilation failed. */
  runs: CheckRun[];
  /** Absent without `review.test_reports` or when no report matched: the gates fall back to exit codes. */
  cases?: TestCase[];
}

/** What a gate found: `problems` go back to the session, `warnings` to the group's gate. */
export interface GateResult {
  problems: string[];
  warnings: string[];
}

/** `logPath` maps a log to where the session reads it (`describeFailures`). */
export type LogPath = (log: string) => string;

export async function runTests(flow: FlowRun, cwd: string, scope: ChecksScope, commands: string[]): Promise<TestRun> {
  const { compile, test_reports: reports } = flow.context.config.review;
  if (reports) clearReports(cwd, reports);
  let compileRun: CheckRun | undefined;
  if (compile) {
    [compileRun] = await runChecks(flow, cwd, { ...scope, label: `${scope.label}-compile` }, [compile]);
    if (!passed(compileRun!)) return { compile: compileRun, runs: [] };
  }
  const runs = commands.length ? await runChecks(flow, cwd, scope, commands) : [];
  const cases = reports ? readReports(cwd, reports) : undefined;
  return { ...(compileRun && { compile: compileRun }), runs, ...(cases && { cases }) };
}

/**
 * `runTests` and a gate over it; when the gate has problems and a command failed, the failed commands once more
 * and the gate again (`rerunFailed`), before the session is woken. Not after a red compilation — that's the code's.
 */
export async function gatedTests(
  flow: FlowRun,
  cwd: string,
  scope: ChecksScope,
  commands: string[],
  gate: (run: TestRun) => string[],
): Promise<{ run: TestRun; problems: string[] }> {
  const run = await runTests(flow, cwd, scope, commands);
  const problems = gate(run);
  if (!problems.length || run.runs.every(passed)) return { run, problems };
  const reports = flow.context.config.review.test_reports;
  // the reports of the commands that passed stay; a rerun one writes its own anew
  const runs = await rerunFailed(flow, cwd, scope, run.runs);
  const cases = reports ? readReports(cwd, reports) : undefined;
  const again: TestRun = { ...(run.compile && { compile: run.compile }), runs, ...(cases && { cases }) };
  return { run: again, problems: gate(again) };
}

/** A note for the gate when the run had no reports to read. */
export function reportsWarning(flow: FlowRun, what: string): string {
  const glob = flow.context.config.review.test_reports;
  const why = glob ? `glob \`${glob}\` found nothing` : 'no `review.test_reports`';
  return `⚠ ${what} without JUnit reports (${why}): command exit codes only${flow.context.config.review.compile ? '' : ', no `review.compile`'}`;
}

/**
 * The red gate: on the base code every new test compiles and fails on an assertion —
 * not an error, not skipped, not green. A green test passes only for a criterion in `already_met`.
 * Without reports: the compilation green and some command red.
 */
export function redGate(written: WriteTestsArtifact, run: TestRun, logPath: LogPath): string[] {
  if (run.compile && !passed(run.compile)) {
    return [`The tests don't compile:\n\n${describeFailures([run.compile], logPath)}`];
  }
  if (!run.cases) {
    if (!run.runs.length || !run.runs.every(passed)) return [];
    return [
      `Every check passes with your tests on the base code, so none of them fails before the implementation. ${GREEN_HINT}`,
    ];
  }
  const alreadyMet = new Set((written.already_met ?? []).map((entry) => entry.ac));
  const problems = written.tests.flatMap((test) => {
    const label = `\`${test.name}\` (${test.path})`;
    const cases = casesOf(test, run.cases!);
    if (!cases.length) return [`${label}: ${notReported(test, run.cases!)}`];
    const met = test.ac.every((id) => alreadyMet.has(id));
    return cases.flatMap((testCase) => {
      const message = testCase.message ? `: ${testCase.message}` : '';
      switch (testCase.status) {
        case 'failed':
          return met ? [`${label} fails, but ${test.ac.join(', ')} is in \`already_met\`${message}`] : [];
        case 'error':
          return [`${label} errors instead of failing on an assertion${message}`];
        case 'skipped':
          return [`${label} is skipped`];
        case 'passed':
          return met ? [] : [`${label} passes on the base code`];
      }
    });
  });
  if (!problems.length) return [];
  const missing = written.tests.some((test) => !casesOf(test, run.cases!).length);
  const failed = run.runs.filter((check) => !passed(check));
  return [
    [
      'The red gate: before any implementation every new test must compile and fail on an assertion about the missing behavior.',
      ...problems.map((problem) => `- ${problem}`),
      GREEN_HINT,
      // smoke 92-2: `./gradlew test integration` stopped at the red `test`, so the integration tests never ran
      ...(missing && failed.length
        ? [MISSING_HINT, ...failed.map((check) => `✗ \`${check.command}\` (exit ${check.exitCode}) — full log: ${logPath(check.log)}`)]
        : []),
    ].join('\n'),
  ];
}

/**
 * A wrong name only when the report has the test's file under other names; no case from that file is a missing
 * report (its runner writes no JUnit XML, its suite never ran) — renaming wouldn't help (a pilot flow:
 * two resumes spent renaming tests vitest never reported).
 */
function notReported(test: WriteTestsArtifact['tests'][number], cases: TestCase[]): string {
  const names = [...new Set(casesOfFile(test, cases).map((testCase) => testCase.name))];
  if (!names.length) return NO_REPORT;
  const shown = names.slice(0, 5).map((name) => `\`${name}\``).join(', ');
  return `not in the test reports under this name — its \`name\` must be the name the report shows; the report has from its file: ${shown}${names.length > 5 ? ', …' : ''}`;
}

const NO_REPORT =
  "no test report has any test of its file — its runner may write no JUnit XML that `review.test_reports` matches, or its suite didn't run. Don't rename it for this: the setup is the human's to fix";

const MISSING_HINT =
  "A test missing from the reports may also not have run: a command that fails can stop before the suite that holds it (Gradle stops at the first failed task). Check the logs below: if your test is named right but its suite never ran, don't rename it — the `checks` are the human's to fix, and the gate shows them these logs.";

const GREEN_HINT =
  'Fix the test (or the stub) so it fails for the right reason. If the base code already does what a criterion asks, keep the test and list the criterion in `already_met` with evidence.';

/** Cases green at the red gate that aren't the new tests: they must stay green after every task. */
export function greenBefore(written: WriteTestsArtifact, cases: TestCase[]): TestCase[] {
  const newTests = new Set(written.tests.flatMap((test) => casesOf(test, cases)));
  return cases.filter((testCase) => testCase.status === 'passed' && !newTests.has(testCase));
}

/**
 * The gate after a task that isn't the group's last: the code compiles, cases green before the
 * group's tests still pass, and the group's tests of criteria implemented so far pass. The rest may stay red.
 */
export function taskGate(target: WriteTestsArtifact['tests'], greenKeys: string[], run: TestRun, logPath: LogPath): string[] {
  if (run.compile && !passed(run.compile)) return [`The code doesn't compile:\n\n${describeFailures([run.compile], logPath)}`];
  if (!run.cases) return [];
  const cases = run.cases;
  const byKey = new Map(cases.map((testCase) => [caseKey(testCase), testCase]));
  const broken = greenKeys.flatMap((key) => {
    const testCase = byKey.get(key);
    return testCase && testCase.status !== 'passed' ? [`- ${testCase.classname} › ${testCase.name}: ${testCase.status}${testCase.message ? ` (${testCase.message})` : ''}`] : [];
  });
  const red = target.flatMap((test) => {
    const found = casesOf(test, cases);
    if (!found.length) return [`- \`${test.name}\` (${test.path}): not in the test reports`];
    return found.filter((testCase) => testCase.status !== 'passed').map((testCase) => `- \`${test.name}\` (${test.path}): ${testCase.status}${testCase.message ? ` (${testCase.message})` : ''}`);
  });
  const logs = run.runs.filter((check) => !passed(check)).map((check) => `full log of \`${check.command}\`: ${logPath(check.log)}`);
  return [
    ...(broken.length ? [['Tests that passed before your task fail now:', ...broken].join('\n')] : []),
    ...(red.length ? [['Tests of the criteria implemented so far that still fail:', ...red].join('\n')] : []),
    ...(broken.length || red.length ? logs : []),
  ];
}
