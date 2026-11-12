import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { detectStack, runInit, type InitDeps } from '../src/init.js';
import { repoReadiness } from '../src/repo-readiness.js';
import { gitRepo, tmpDir, write } from './helpers.js';

// Init writes the repo config for the detected build and the ticket template.

function fakeInit(overrides: Partial<InitDeps> & { answers?: boolean[] } = {}) {
  const { answers = [], ...rest } = overrides;
  const questions: string[] = [];
  const output: string[] = [];
  const deps: InitDeps = {
    confirm: async (question) => {
      questions.push(question);
      return answers.shift() ?? false;
    },
    interactive: true,
    say: (text) => output.push(text),
    ...rest,
  };
  return { deps, questions, output };
}

const repo = () => gitRepo(tmpDir());
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (root: string, file: string) => fs.existsSync(path.join(root, file));

describe('init: stack detection', () => {
  it('Gradle with a wrapper: build that keeps going past a red task, compile, JUnit reports', () => {
    const root = repo();
    write(root, 'build.gradle.kts', '');
    write(root, 'gradlew', '');
    expect(detectStack(root)).toEqual({
      stack: 'Gradle (wrapper)',
      review: { checks: ['./gradlew build --continue'], compile: './gradlew testClasses', test_reports: '**/build/test-results/**/*.xml' },
      others: [],
    });
  });

  it('Maven without a wrapper; surefire and failsafe reports', () => {
    const root = repo();
    write(root, 'pom.xml', '<project/>');
    expect(detectStack(root)?.review).toEqual({ checks: ['mvn -B -fae verify'], compile: 'mvn -B test-compile', test_reports: '**/target/*-reports/TEST-*.xml' });
  });

  it('npm: the repo `ci` script wins; otherwise typecheck, lint, build, test in order, with the lockfile manager', () => {
    const withCi = repo();
    write(withCi, 'package.json', JSON.stringify({ scripts: { ci: 'x', test: 'y' } }));
    expect(detectStack(withCi)?.review).toEqual({ checks: ['npm run ci'] });

    const scripts = repo();
    write(scripts, 'package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc', start: 'node' } }));
    write(scripts, 'pnpm-lock.yaml', '');
    expect(detectStack(scripts)).toEqual({
      stack: 'pnpm',
      review: { checks: ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test'], compile: 'pnpm run typecheck' },
      others: [],
    });
  });

  it('a JVM build wins over a frontend package.json, which is named for the human; nothing known gives no proposal', () => {
    const both = repo();
    write(both, 'pom.xml', '<project/>');
    write(both, 'package.json', JSON.stringify({ scripts: { test: 'jest' } }));
    expect(detectStack(both)).toMatchObject({ stack: 'Maven', others: ['npm'] });

    const unknown = repo();
    write(unknown, 'package.json', JSON.stringify({ scripts: { start: 'node' } }));
    write(unknown, 'Makefile', '');
    expect(detectStack(unknown)).toBeUndefined();
  });
});

describe('init: writing', () => {
  it('after a yes writes a config the loader accepts and the ticket template', async () => {
    const root = repo();
    write(root, 'build.gradle', '');
    write(root, 'gradlew', '');
    const { deps, questions } = fakeInit({ answers: [true] });
    await runInit({ cwd: root }, deps);
    expect(questions).toEqual(['Write?']);
    expect(parse(read(root, '.agentic/config.yaml'))).toEqual({
      review: { checks: ['./gradlew build --continue'], compile: './gradlew testClasses', test_reports: '**/build/test-results/**/*.xml' },
    });
    expect(loadConfig({ cwd: root, env: { AGENTIC_HOME: tmpDir() } }).config.review.checks).toEqual(['./gradlew build --continue']);
    expect(read(root, '.agentic/templates/ticket.md')).toMatch(/## Acceptance criteria/);
  });

  it('containers in tests: points at sandbox.containers, which only the global config sets', async () => {
    const root = repo();
    write(root, 'build.gradle', "testImplementation 'org.testcontainers:postgresql:1.20.4'\n");
    const { deps, output } = fakeInit({ answers: [false] });
    await runInit({ cwd: root }, deps);
    expect(output).toContainEqual(expect.stringMatching(/build.gradle \(Testcontainers\)[\s\S]*`sandbox.containers: true` in ~\/.agentic\/config.yaml/));

    const plain = repo();
    write(plain, 'build.gradle', '');
    const without = fakeInit({ answers: [false] });
    await runInit({ cwd: plain }, without.deps);
    expect(without.output.join('\n')).not.toMatch(/sandbox.containers/);
  });

  it('a no writes nothing', async () => {
    const root = repo();
    write(root, 'pom.xml', '<project/>');
    const { deps, output } = fakeInit({ answers: [false] });
    await runInit({ cwd: root }, deps);
    expect(exists(root, '.agentic')).toBe(false);
    expect(output).toContain('Nothing written.');
    expect(output).toContain('  ✗ .agentic/config.yaml — `agentic init`');
  });

  it('never overwrites: an existing config and template stay, and nothing is asked', async () => {
    const root = repo();
    write(root, 'pom.xml', '<project/>');
    write(root, '.agentic/config.yaml', 'review:\n  checks: none\n');
    write(root, '.agentic/templates/ticket.md', 'ours');
    const { deps, questions, output } = fakeInit({ answers: [true] });
    await runInit({ cwd: root }, deps);
    expect(questions).toEqual([]);
    expect(read(root, '.agentic/config.yaml')).toBe('review:\n  checks: none\n');
    expect(read(root, '.agentic/templates/ticket.md')).toBe('ours');
    expect(output).toContain('  ✓ .agentic/config.yaml');
  });

  it('without a terminal only previews; --yes writes without asking', async () => {
    const root = repo();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    const preview = fakeInit({ interactive: false });
    await runInit({ cwd: root }, preview.deps);
    expect(exists(root, '.agentic')).toBe(false);
    expect(preview.output.join('\n')).toMatch(/npm run test[\s\S]*agentic init --yes/);

    const forced = fakeInit({ interactive: false });
    await runInit({ cwd: root, yes: true }, forced.deps);
    expect(forced.questions).toEqual([]);
    expect(parse(read(root, '.agentic/config.yaml'))).toEqual({ review: { checks: ['npm run test'] } });
  });

  it('an unknown build gets instructions instead of a config; the ticket template is still offered', async () => {
    const root = repo();
    const { deps, output } = fakeInit({ answers: [true] });
    await runInit({ cwd: root }, deps);
    expect(output.join('\n')).toMatch(/no known build found/);
    expect(exists(root, '.agentic/config.yaml')).toBe(false);
    expect(exists(root, '.agentic/templates/ticket.md')).toBe(true);
  });

  it('refuses to run outside git', async () => {
    await expect(runInit({ cwd: tmpDir() }, fakeInit().deps)).rejects.toThrow(/works in a git repo/);
  });
});

describe('init: what the repo has for agents', () => {
  it('a re-run writes nothing and lists what is there and what makes the rest', async () => {
    const root = repo();
    write(root, '.agentic/config.yaml', 'review:\n  checks: none\n');
    write(root, '.agentic/templates/ticket.md', 'ours');
    write(root, 'CLAUDE.md', '# Agents\n\n## Agentic\n\nours\n');
    write(root, '.agentic/standards/testing.md', '# Testing');
    const { deps, questions, output } = fakeInit();
    await runInit({ cwd: root }, deps);
    expect(questions).toEqual([]);
    expect(output.slice(output.indexOf('The repo for agents:'))).toEqual([
      'The repo for agents:',
      '  ✓ .agentic/config.yaml',
      '  ✓ .agentic/templates/ticket.md',
      '  ✗ .agentic/context-map.md — `/agentic-context-map` in Claude Code or Codex (`agentic skills install`)',
      '  ✓ CLAUDE.md',
      '  ✓ .agentic/standards/testing.md',
      "  ✗ .agentic/standards/architecture.md, code.md — the standards review checks only the framework's AG- rules for now",
      '  standards: rules with IDs, e.g. `- **TEST-01 Title.** …`',
      'Next: `agentic doctor`, then `agentic new "<idea>"`.',
    ]);
  });

  it('adds the `## Agentic` section to the AGENTS.md the repo has, once, pointing to the map where it is; a repo without one gets none', async () => {
    const root = repo();
    write(root, '.agentic/config.yaml', 'review:\n  checks: none\n');
    write(root, '.agentic/templates/ticket.md', 'ours');
    write(root, 'AGENTS.md', '# Service\n\nBuild: `./gradlew build`');
    write(root, 'CLAUDE.md', '@AGENTS.md\n');
    await runInit({ cwd: root }, fakeInit({ answers: [true] }).deps);
    expect(read(root, 'AGENTS.md')).toMatch(/^# Service\n\nBuild: `\.\/gradlew build`\n\n## Agentic\n\n[\s\S]*`\.agentic\/context-map\.md`/);
    expect(read(root, 'CLAUDE.md')).toBe('@AGENTS.md\n');

    const again = fakeInit({ answers: [true] });
    await runInit({ cwd: root }, again.deps);
    expect(again.questions).toEqual([]);
    expect(read(root, 'AGENTS.md').match(/## Agentic/g)).toHaveLength(1);

    const rootMap = repo();
    write(rootMap, 'CONTEXT-MAP.md', '# Map');
    write(rootMap, 'AGENTS.md', '# Service\n');
    await runInit({ cwd: rootMap }, fakeInit({ answers: [true] }).deps);
    expect(read(rootMap, 'AGENTS.md')).toMatch(/^- `CONTEXT-MAP\.md` — /m);

    const bare = repo();
    write(bare, 'pom.xml', '<project/>');
    await runInit({ cwd: bare }, fakeInit({ answers: [true] }).deps);
    expect(exists(bare, 'AGENTS.md')).toBe(false);
  });

  it("a map the repo keeps at its root and a team's own standard files count: the three names are not asked for", () => {
    const root = repo();
    write(root, '.agentic/standards/backend.md', '# Backend');
    write(root, '.agentic/standards/testing.md', '# Testing');
    write(root, 'AGENTS.md', '# Agents');
    write(root, 'CLAUDE.md', '@AGENTS.md');
    write(root, 'CONTEXT-MAP.md', '# Map');
    const items = repoReadiness(root);
    expect(items.find((item) => item.file === 'CONTEXT-MAP.md')).toMatchObject({ present: true });
    expect(items.find((item) => item.file.startsWith('AGENTS'))).toEqual({ file: 'AGENTS.md + CLAUDE.md', present: true, detail: '' });
    expect(items.filter((item) => item.file.includes('standards'))).toEqual([
      { file: '.agentic/standards', present: true, detail: 'own standards: backend.md, testing.md' },
    ]);
  });
});
