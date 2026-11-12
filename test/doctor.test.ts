import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustChecks } from '../src/config/trusted-checks.js';
import { runDoctor } from '../src/doctor.js';
import { gitRepo, sandboxEnv, tmpDir, write } from './helpers.js';

describe('doctor', () => {
  const deps = {
    harnessStatus: async (name: string) => (name === 'claude' ? { installed: true, version: '1.0.0' } : { installed: false }),
    engineVersion: async () => undefined,
    frameworkVersion: '0.1.0',
    gitleaksVersion: async () => '8.30.1',
  };

  it('reports what is missing and suggests commands without changing anything', async () => {
    const root = tmpDir();
    const checks = await runDoctor({ cwd: root, env: sandboxEnv(path.join(root, 'home')) }, deps);
    const checksByName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(checksByName.claude).toMatchObject({ level: 'warn', fix: 'claude update' }); // 1.0.0 < catalog min
    expect(checksByName.codex).toMatchObject({ level: 'error', fix: 'npm install -g @openai/codex' }); // used by tiers
    expect(checks.find((check) => check.name === 'sandbox')).toMatchObject({ level: 'error', detail: 'podman unavailable (sandbox.mode: container)' });
    expect(checksByName.profile).toMatchObject({ level: 'warn' });
  });

  it('an unused harness is only a warning; requires_framework is checked', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', `requires_framework: ">=1.4"
sandbox: { mode: none }
tiers:
  mechanical: { harness: claude, model: haiku, effort: low }
  standard: { harness: claude, model: sonnet, effort: medium }
  domain: { harness: claude, model: sonnet, effort: high }
review:
  spec: { harness: claude, model: sonnet, effort: medium }
stages:
  write-tests: { harness: claude, model: opus, effort: medium }
`);
    const checksByName = Object.fromEntries((await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).map((check) => [check.name, check]));
    expect(checksByName.codex!.level).toBe('warn');
    expect(checksByName.framework).toMatchObject({ level: 'error', detail: '0.1.0, the workspace needs >=1.4' });
    expect(checksByName.sandbox!.level).toBe('warn');
  });

  it('warns when a linked checkout runs a build older than its sources', async () => {
    const root = tmpDir();
    const env = sandboxEnv(path.join(root, 'home'));
    const stale = { built: new Date(2026, 9, 24, 20, 0), changed: new Date(2026, 9, 24, 22, 32) };
    const checks = await runDoctor({ cwd: root, env }, { ...deps, staleBuild: () => stale });
    expect(checks.find((check) => check.name === 'framework')).toMatchObject({
      level: 'warn',
      detail: 'agentic built 2026-10-24 20:00, but src/ changed 2026-10-24 22:32; flows will run older code',
      fix: expect.stringMatching(/npm run build$/),
    });
    expect((await runDoctor({ cwd: root, env }, { ...deps, staleBuild: () => undefined })).some((check) => check.name === 'framework')).toBe(false);
  });

  it('suggests a dictation app without failing when none is installed', async () => {
    const root = tmpDir();
    const env = sandboxEnv(path.join(root, 'home'));
    const missing = await runDoctor({ cwd: root, env }, { ...deps, dictationApp: async () => undefined });
    expect(missing.find((check) => check.name === 'dictation')).toMatchObject({ level: 'info', fix: expect.stringMatching(/handy/i) });
    const found = await runDoctor({ cwd: root, env }, { ...deps, dictationApp: async () => 'Handy' });
    expect(found.find((check) => check.name === 'dictation')).toMatchObject({ level: 'ok', detail: 'Handy' });
  });

  it('lists active framework rules and what the config switched off', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'skills: { disabled: [agentic-clean-code, agentic-implement] }\nrules: { disabled: [AG-TQ-04, AG-NOPE-01] }\n');
    const rules = (await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).filter((check) => check.name === 'rules');
    expect(rules[0]).toMatchObject({ level: 'ok', detail: expect.stringMatching(/active: 4\/5; off: AG-TQ-04 \(rules.disabled: global\).*skills.disabled: global\): agentic-clean-code/) });
    expect(rules.map((check) => check.detail)).toEqual(
      expect.arrayContaining([expect.stringMatching(/AG-NOPE-01/), expect.stringMatching(/agentic-implement \(a stage skill cannot be turned off/)]),
    );
  });

  it('in a service repo lists what it has for agents; what is missing is only a suggestion', async () => {
    const root = gitRepo(tmpDir());
    write(root, '.agentic/context-map.md', '# Map');
    const repo = (await runDoctor({ cwd: root, env: sandboxEnv(tmpDir()) }, deps)).filter((check) => check.name === 'repo');
    expect(repo.find((check) => check.detail === '.agentic/context-map.md')).toMatchObject({ level: 'ok' });
    expect(repo.find((check) => check.detail === 'no .agentic/templates/ticket.md')).toMatchObject({ level: 'info', fix: '`agentic init`' });
    expect(repo.filter((check) => check.level !== 'ok').every((check) => check.level === 'info')).toBe(true);
    expect(await runDoctor({ cwd: tmpDir(), env: sandboxEnv(tmpDir()) }, deps)).not.toContainEqual(expect.objectContaining({ name: 'repo' }));
  });

  it('git older than merge-tree --write-tree is an error', async () => {
    const root = tmpDir();
    const old = await runDoctor({ cwd: root, env: sandboxEnv(path.join(root, 'home')) }, { ...deps, gitVersion: async () => '2.30.1' });
    expect(old.find((check) => check.name === 'git')).toMatchObject({ level: 'error', detail: '2.30.1 < 2.40.0 (merging group branches, PR size in publish)' });
  });

  it('missing checks are an error; on the host, checks without consent are a warning', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const byName = async () => Object.fromEntries((await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).map((check) => [check.name, check]));
    expect((await byName()).checks).toMatchObject({ level: 'error', detail: expect.stringMatching(/`review.checks` not set/), fix: expect.stringMatching(/agentic init[\s\S]*gradlew/) });

    write(home, 'config.yaml', 'sandbox: { mode: none }\nreview: { checks: [npm test] }\n');
    expect((await byName()).checks).toMatchObject({ level: 'warn', detail: 'npm test; no consent to run on the host' });
    trustChecks(home, root, ['npm test']);
    expect((await byName()).checks).toMatchObject({ level: 'ok', detail: 'npm test' });
    // `review.compile` runs on the host too: consent to the checks alone doesn't cover it (smoke 92-2)
    write(home, 'config.yaml', 'sandbox: { mode: none }\nreview: { checks: [npm test], compile: npm run build }\n');
    expect((await byName()).checks!.level).toBe('warn');
    trustChecks(home, root, ['npm test', 'npm run build']);
    expect((await byName()).checks!.level).toBe('ok');

    write(home, 'config.yaml', 'review: { checks: none }\n');
    expect((await byName()).checks!.level).toBe('warn');
  });

  it('test reports: every runner of checks writes JUnit XML the glob matches (a pilot flow: vitest wrote none)', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(root, 'package.json', JSON.stringify({ workspaces: ['frontend'], scripts: { test: 'npm run test -w frontend' } }));
    write(root, 'frontend/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write(root, 'frontend/vitest.config.ts', "export default { test: { environment: 'node' } };\n");
    const config = (reports: string) => `review:\n  checks: ["cd backend && ./gradlew test --continue", "npm run test"]\n  test_reports: "${reports}"\n`;
    const reports = async () => (await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).filter((check) => check.name === 'test reports');

    write(home, 'config.yaml', config('{backend,frontend}/build/test-results/**/*.xml'));
    expect(await reports()).toEqual([
      expect.objectContaining({ level: 'warn', detail: "vitest in `npm run test` (frontend) writes no JUnit XML; the gates won't see its tests", fix: expect.stringMatching(/reporters: \['default', 'junit'\]/) }),
    ]);

    write(root, 'frontend/vitest.config.ts', "export default { test: { reporters: ['default', 'junit'], outputFile: { junit: './reports/junit.xml' } } };\n");
    expect(await reports()).toEqual([expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/writes its report to `frontend\/reports\/junit.xml`, which `review.test_reports`/) })]);
    write(home, 'config.yaml', config('{backend/build/test-results/**/*.xml,frontend/reports/*.xml}'));
    expect(await reports()).toEqual([expect.objectContaining({ level: 'ok', detail: expect.stringMatching(/\(gradle, vitest\)$/) })]);

    write(home, 'config.yaml', 'review:\n  checks: ["./gradlew build"]\n');
    expect(await reports()).toEqual([expect.objectContaining({ level: 'info', detail: expect.stringMatching(/no `review.test_reports`/) })]);
  });

  it('containers in tests: in a container they need sandbox.containers; on the host, a container engine', async () => {
    const root = gitRepo(tmpDir());
    const home = tmpDir();
    write(root, 'build.gradle', "testImplementation 'org.testcontainers:postgresql:1.20.4'\n");
    const containerChecks = async (config: string, engines: string[] = ['podman']) => {
      write(home, 'config.yaml', config);
      const engineVersion = async (engine: string) => (engines.includes(engine) ? '5.4.0' : undefined);
      return (await runDoctor({ cwd: root, env: sandboxEnv(home) }, { ...deps, engineVersion })).filter((check) => check.name === 'container tests');
    };

    expect(await containerChecks('sandbox: { mode: container }\n')).toEqual([
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/build.gradle \(Testcontainers\).*`sandbox.containers: false`/), fix: expect.stringMatching(/`sandbox.containers: true` in ~\/.agentic\/config.yaml/) }),
    ]);
    expect(await containerChecks('sandbox: { mode: container, containers: true }\n')).toEqual([expect.objectContaining({ level: 'ok' })]);
    expect(await containerChecks('sandbox: { mode: none }\n', ['docker'])).toEqual([expect.objectContaining({ level: 'ok', detail: expect.stringMatching(/on the host: docker 5.4.0/) })]);
    expect(await containerChecks('sandbox: { mode: none }\n', [])).toEqual([
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/the host has no running Docker or Podman/) }),
    ]);

    write(root, 'build.gradle', 'plugins { java }\n');
    expect(await containerChecks('sandbox: { mode: container }\n')).toEqual([]);
    expect(await containerChecks('sandbox: { mode: container, containers: true }\n')).toEqual([
      expect.objectContaining({ level: 'info', detail: expect.stringMatching(/shows no Testcontainers/) }),
    ]);
  });

  it('a company gateway in a container: the token from settings.json signs in; HTTPS on 443 only', async () => {
    const root = tmpDir();
    const home = tmpDir();
    const configDir = tmpDir();
    write(home, 'config.yaml', 'sandbox: { mode: container }\ntiers: { mechanical: { model: haiku }, standard: { model: sonnet }, domain: { model: opus } }\n');
    const sandbox = async (url: string) => {
      write(configDir, 'settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: 'secret' } }));
      const env = { ...sandboxEnv(home), CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined };
      return (await runDoctor({ cwd: root, env }, deps)).filter((check) => check.name === 'sandbox' && /claude/.test(check.detail));
    };
    expect(await sandbox('https://llm.example.com')).toEqual([
      expect.objectContaining({ level: 'ok', detail: expect.stringMatching(/claude in a container through gateway llm.example.com \(.*settings.json\), host added to the session allowlist/) }),
    ]);
    expect(await sandbox('http://llm.example.com:4000')).toEqual([
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/the session proxy only lets HTTPS on port 443 through/) }),
    ]);
  });

  it('Codex through a company gateway in a container: the provider from config.toml and its key', async () => {
    const root = tmpDir();
    const home = tmpDir();
    const codexHome = tmpDir();
    write(home, 'config.yaml', 'sandbox: { mode: container }\n');
    write(codexHome, 'config.toml', 'model_provider = "litellm"\n[model_providers.litellm]\nbase_url = "https://llm.example.com/v1"\nenv_key = "LITELLM_API_KEY"\n');
    const codex = async (env: NodeJS.ProcessEnv) =>
      (await runDoctor({ cwd: root, env: { ...sandboxEnv(home), CODEX_HOME: codexHome, CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined, LITELLM_API_KEY: undefined, ...env } }, deps)).filter(
        (check) => check.name === 'sandbox' && /codex/.test(check.detail),
      );
    expect(await codex({})).toEqual([expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/codex in a container won't sign in: missing LITELLM_API_KEY/) })]);
    expect(await codex({ LITELLM_API_KEY: 'k' })).toEqual([
      expect.objectContaining({ level: 'ok', detail: expect.stringMatching(/codex in a container through provider litellm \(llm.example.com, from .*config.toml\)/) }),
    ]);
  });

  it('warns about on_stop: escalate without a ladder and stop_on: budget, which change nothing', async () => {
    const review = async (yaml: string) => {
      const root = tmpDir();
      const home = path.join(root, 'home');
      write(home, 'config.yaml', yaml);
      return (await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).filter((check) => check.name === 'review').map((check) => check.detail);
    };
    expect(await review('review: { on_stop: [escalate, human], stop_on: [budget] }\n')).toEqual([
      expect.stringMatching(/escalate.*without a model ladder/),
      expect.stringMatching(/stop_on: budget.*always/),
    ]);
    expect(await review('review: { on_stop: [escalate, human], escalation: [sonnet, opus] }\n')).toEqual([]);
  });

  it('a host read list that re-opens credentials is an error', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'sandbox: { mode: none, host: { read: [~/.m2, ~/.aws/credentials] } }\n');
    const checksByName = Object.fromEntries((await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps)).map((check) => [check.name, check]));
    expect(checksByName.sandbox).toMatchObject({ level: 'error', detail: expect.stringMatching(/`~\/.aws\/credentials`: lies inside the protected `~\/.aws`/) });
  });

  it('invalid config → error with validation details', async () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'autonomy: yolo\n');
    const checks = await runDoctor({ cwd: root, env: sandboxEnv(home) }, deps);
    expect(checks.at(-1)).toMatchObject({ name: 'config', level: 'error' });
    expect(checks.at(-1)!.detail).toMatch(/autonomy: allowed values/);
  });
});
