import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults.js';
import { NO_PROFILE, loadConfig } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { checksTrusted, trustChecks, trustFile } from '../src/config/trusted-checks.js';
import type { AgenticConfig } from '../src/config/types.js';
import { ConfigError } from '../src/config/validate.js';
import { fakeRegistry } from '../src/harness/fake.js';
import { gatedTests } from '../src/orchestrator/test-gates.js';
import { checkCommands, checksReport, checksTimeoutMs, describeFailures, ERROR_LINE_PATTERN, failureExcerpt, MISSING_CHECKS, parseDuration, passed, rerunFailed, runChecks, writeChecksRunner } from '../src/orchestrator/checks.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { FlowRun, Halt } from '../src/orchestrator/run.js';
import { newState } from '../src/orchestrator/state.js';
import { HostSandbox } from '../src/sandbox/host.js';
import { gitRepo, sandboxEnv, tmpDir, write } from './helpers.js';

function flowRun(options: { review?: Partial<AgenticConfig['review']>; trusted?: boolean } = {}) {
  const root = tmpDir();
  const workDir = path.join(root, 'work', 'flow');
  const code = path.join(root, 'code');
  fs.mkdirSync(code, { recursive: true });
  const config = { ...DEFAULTS, review: { ...DEFAULTS.review, ...options.review } };
  const { claude, codex } = fakeRegistry();
  const lines: string[] = [];
  const run = new FlowRun(
    {
      workDir,
      config,
      catalog: loadCatalog(),
      profile: NO_PROFILE,
      harnesses: { claude, codex },
      sandbox: new HostSandbox(),
      gates: new ScriptedGates(),
      checksTrusted: options.trusted ?? true,
      log: (line) => lines.push(line),
    },
    newState({ slug: 'flow', title: 'flow', entry: 'new', origin: { repoRoot: code } }),
  );
  return { run, code, workDir, lines };
}

describe('checks config', () => {
  it('an unset list is a start error with an example; `none` is a deliberate opt-out', () => {
    expect(() => checkCommands({ checks: [] })).toThrow(MISSING_CHECKS);
    expect(MISSING_CHECKS).toMatch(/gradlew/);
    expect(MISSING_CHECKS).toMatch(/npm test/);
    expect(MISSING_CHECKS).toMatch(/`agentic init`/);
    expect(checkCommands({ checks: 'none' })).toBe('none');
    expect(checkCommands({ checks: ['npm test'] })).toEqual(['npm test']);
  });

  it('durations take seconds or minutes; the timeout is cut to the global ceiling', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(() => parseDuration('5h')).toThrow(/invalid duration/);
    expect(checksTimeoutMs({ checks_timeout: '30m', checks_timeout_max: '60m' })).toBe(30 * 60_000);
    expect(checksTimeoutMs({ checks_timeout: '90m', checks_timeout_max: '60m' })).toBe(60 * 60_000);
    expect(DEFAULTS.review.checks_timeout).toBe('5m');
  });

  it('a repo sets its checks and timeout, but not the ceiling; an empty list is rejected', () => {
    const root = tmpDir();
    const env = sandboxEnv(path.join(root, 'home'));
    const repo = gitRepo(path.join(root, 'repo'));
    write(repo, '.agentic/config.yaml', 'review:\n  checks: none\n  checks_timeout: 30m\n');
    expect(loadConfig({ cwd: repo, env }).config.review).toMatchObject({ checks: 'none', checks_timeout: '30m', checks_timeout_max: '60m' });

    write(repo, '.agentic/config.yaml', 'review:\n  checks_timeout_max: 120m\n');
    expect(() => loadConfig({ cwd: repo, env })).toThrow(ConfigError);

    write(repo, '.agentic/config.yaml', 'review:\n  checks: []\n');
    expect(() => loadConfig({ cwd: repo, env })).toThrow(ConfigError);
  });
});

describe('trusted checks', () => {
  it('consent holds per repo and per exact command list', () => {
    const globalDir = path.join(tmpDir(), 'agentic');
    expect(checksTrusted(globalDir, '/repo/a', ['npm test'])).toBe(false);
    trustChecks(globalDir, '/repo/a', ['npm test']);
    expect(fs.existsSync(trustFile(globalDir))).toBe(true);
    expect(checksTrusted(globalDir, '/repo/a', ['npm test'])).toBe(true);
    expect(checksTrusted(globalDir, '/repo/a', ['npm test', 'npm run lint'])).toBe(false);
    expect(checksTrusted(globalDir, '/repo/b', ['npm test'])).toBe(false);
  });

  it('a broken trust file trusts nothing', () => {
    const globalDir = tmpDir();
    fs.writeFileSync(trustFile(globalDir), 'repos: [');
    expect(checksTrusted(globalDir, '/repo/a', ['npm test'])).toBe(false);
  });
});

describe('runChecks', () => {
  const secret = 'AGENTIC_TEST_API_KEY';
  afterEach(() => {
    delete process.env[secret];
  });

  it('runs each command in the clone, logs the whole output and keeps its tail', async () => {
    const { run, code, workDir } = flowRun();
    fs.writeFileSync(path.join(code, 'marker'), 'here');
    const runs = await runChecks(run, code, { owner: 'g1', label: 't1' }, ['cat marker', 'seq 1 300; exit 3']);

    expect(runs.map((check) => [check.command, check.exitCode, passed(check)])).toEqual([
      ['cat marker', 0, true],
      ['seq 1 300; exit 3', 3, false],
    ]);
    expect(runs[1]!.log).toBe(path.join(workDir, 'checks', 'g1-t1-2-seq-1-300-exit-3.log'));
    expect(fs.readFileSync(runs[1]!.log, 'utf8').split('\n')[0]).toBe('1');
    expect(runs[1]!.excerpt.split('\n')).toHaveLength(200);
    expect(runs[1]!.excerpt.split('\n')[0]).toBe('101');
    expect(describeFailures(runs)).toMatch(/✗ `seq 1 300; exit 3` \(exit 3\) — full log: .*g1-t1-2/);
    expect(describeFailures(runs)).not.toMatch(/cat marker/);
  });

  it('says how far it got after each command', async () => {
    const { run, code, lines } = flowRun();
    await runChecks(run, code, { owner: 'g1', label: 't2' }, ['true', 'exit 1']);
    expect(lines).toEqual([
      '… checks g1/t2: 2 commands',
      '  ✓ g1/t2 1/2: true (0 s)',
      '  ✗ g1/t2 2/2: exit 1 (0 s)',
      expect.stringMatching(/^✗ checks g1\/t2: 1\/2 in 0 s$/),
    ]);
  });

  it('a red command runs once more: green the second time it passes, marked as such', async () => {
    const { run, code, workDir, lines } = flowRun();
    // red the first time only, as Gradle failing to write its reports through the mount (smoke 92-3)
    const flaky = 'test -f once || { touch once; exit 1; }';
    const scope = { owner: 'g1', label: 't2' };
    const runs = await rerunFailed(run, code, scope, await runChecks(run, code, scope, ['true', flaky, 'exit 2']));
    expect(runs.map((check) => [check.command, check.exitCode, check.retried])).toEqual([
      ['true', 0, undefined],
      [flaky, 0, true],
      ['exit 2', 2, undefined],
    ]);
    expect(runs[2]!.log).toBe(path.join(workDir, 'checks', 'g1-t2-retry-2-exit-2.log'));
    expect(lines).toContain('↻ checks g1/t2: red commands once more');
    expect(lines.some((line) => line.includes('green only on the second try'))).toBe(true);
    expect(checksReport('g1', 'abc', runs)).toContain('green only on the second run');
  });

  it('a gate with problems runs the red commands once more and judges again; green commands are not rerun', async () => {
    const { run, code, workDir } = flowRun();
    const flaky = 'test -f once || { touch once; exit 1; }';
    const gate = (tested: { runs: Array<{ exitCode: number }> }) => (tested.runs.every((check) => check.exitCode === 0) ? [] : ['red']);
    const { run: tested, problems } = await gatedTests(run, code, { owner: 'g1', label: 't2' }, ['true', flaky], gate);
    expect(problems).toEqual([]);
    expect(tested.runs[1]!.retried).toBe(true);
    expect(fs.readdirSync(path.join(workDir, 'checks')).filter((name) => name.includes('retry'))).toEqual(['g1-t2-retry-1-test-f-once-touch-once-exit-1.log']);
  });

  it('a timeout is not run again', async () => {
    const { run, code } = flowRun({ review: { checks_timeout: '1s' } });
    const scope = { owner: 'g1', label: 'r1' };
    const first = await runChecks(run, code, scope, ['sleep 5']);
    expect(await rerunFailed(run, code, scope, first)).toBe(first);
  }, 15_000);

  it('a command past its timeout is red, with a note naming the setting', async () => {
    const { run, code } = flowRun({ review: { checks_timeout: '1s' } });
    const [check] = await runChecks(run, code, { owner: 'g1', label: 'r1' }, ['sleep 5']);
    expect(check!.timedOut).toBe(true);
    expect(passed(check!)).toBe(false);
    expect(check!.excerpt).toMatch(/review\.checks_timeout/);
    expect(describeFailures([check!])).toMatch(/\(timeout\)/);
  }, 15_000);

  it('secrets are not in the environment of the commands', async () => {
    process.env[secret] = 'sk-123';
    const { run, code } = flowRun();
    const [check] = await runChecks(run, code, { owner: 'g1', label: 't1' }, [`echo "[\${${secret}:-unset}]"`]);
    expect(fs.readFileSync(check!.log, 'utf8')).toContain('[unset]');
  });

  it('on the host, without the human’s consent, nothing runs', async () => {
    const { run, code } = flowRun({ trusted: false });
    await expect(runChecks(run, code, { owner: 'g1', label: 't1' }, ['touch ran'])).rejects.toBeInstanceOf(Halt);
    expect(fs.existsSync(path.join(code, 'ran'))).toBe(false);
  });
});

describe('failureExcerpt', () => {
  it('lifts failure lines from above the tail, once each, before the tail itself', () => {
    const output = ['> Task :test', 'FooSpec > bar FAILED', ...Array(50).fill('[WebServer] noise'), 'FooSpec > bar FAILED', 'tail 1', 'tail 2'].join('\n');
    expect(failureExcerpt(output, 2, ERROR_LINE_PATTERN, 40).split('\n')).toEqual([
      '[failure lines above the tail, first 40 at most]',
      'FooSpec > bar FAILED',
      '[last 2 lines]',
      'tail 1',
      'tail 2',
    ]);
  });

  it('a short output is just the tail', () => {
    expect(failureExcerpt('Error: boom\nexit', 200, ERROR_LINE_PATTERN, 40)).toBe('Error: boom\nexit');
  });
});

describe('run-checks', () => {
  const secret = 'AGENTIC_TEST_API_KEY';
  afterEach(() => {
    delete process.env[secret];
  });

  function runner(commands: string[]) {
    const { run, code, workDir } = flowRun();
    const outDir = path.join(workDir, 'out', 'implement-g1-t1');
    const runnerPath = writeChecksRunner(run, { name: 'implement-g1-t1', cwd: code, outDir, commands });
    // called from anywhere, it runs in the clone
    const call = (...args: string[]) => spawnSync(runnerPath, args, { cwd: tmpDir(), encoding: 'utf8', env: process.env });
    return { code, outDir, runnerPath, call };
  }

  it('runs every command in the clone, or just the n-th; logs go to the session’s out/', () => {
    const { code, outDir, call } = runner(['cat marker', 'echo second']);
    fs.writeFileSync(path.join(code, 'marker'), 'here');
    const all = call();
    expect(all.status).toBe(0);
    expect(all.stdout).toMatch(/✓ \[1\] cat marker \(\d+ s\)\n✓ \[2\] echo second/);
    expect(fs.readFileSync(path.join(outDir, 'checks', '1-cat-marker.log'), 'utf8')).toBe('here');
    const second = call('2');
    expect(second.stdout).not.toContain('[1]');
    expect(second.stdout).toContain('✓ [2] echo second');
  });

  it('a failure exits 1 with the log path, failure lines and the tail', () => {
    const { outDir, call } = runner(['echo "Error: boom"; seq 1 100; exit 3']);
    const result = call();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`(exit 3, `);
    expect(result.stdout).toContain(`log: ${path.join(outDir, 'checks', '1-echo-error-boom-seq-1-100-exit-3.log')}`);
    expect(result.stdout).toMatch(/failure lines above the tail[\s\S]*Error: boom[\s\S]*\[last 80 lines\]\n21\n/);
  });

  it('rejects anything but a command number', () => {
    const { call } = runner(['true']);
    for (const args of [['2'], ['0'], ['x'], ['1', '1'], ['1; rm -rf /']]) expect(call(...args).status).toBe(2);
  });

  it('secrets are not in the environment of the commands', () => {
    process.env[secret] = 'sk-123';
    const { outDir, call } = runner([`echo "[\${${secret}:-unset}]"`]);
    expect(call().status).toBe(0);
    expect(fs.readFileSync(path.join(outDir, 'checks', fs.readdirSync(path.join(outDir, 'checks'))[0]!), 'utf8')).toContain('[unset]');
  });

  it('works under a package.json that says `"type": "module"`', () => {
    const { runnerPath } = runner(['true']);
    fs.writeFileSync(path.join(path.dirname(runnerPath), 'package.json'), '{"type":"module"}');
    expect(spawnSync(runnerPath, [], { encoding: 'utf8' }).status).toBe(0);
  });
});
