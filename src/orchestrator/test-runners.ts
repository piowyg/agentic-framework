import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/** A test runner a `review.checks` command starts, and where its JUnit XML lands, when we can tell. */
export interface TestRunner {
  /** `gradle`, `maven`, `vitest`, `jest`, `playwright`. */
  runner: string;
  command: string;
  /** The runner's directory, relative to the repo root (`.` = the root). */
  dir: string;
  /** `false`: the runner writes no JUnit XML (a JS runner without a `junit` reporter). */
  junit: boolean;
  /** A report the runner would write, relative to the repo root; absent when we can't tell (a reporter without `outputFile`). */
  sample?: string;
}

const MAX_SCRIPT_DEPTH = 4;

/**
 * The test runners `commands` start, found by reading them: `cd <dir> &&`, Gradle and Maven, and package scripts
 * (`npm run test -w frontend` → frontend's `vitest run`), followed through scripts that call other scripts.
 * A heuristic for `doctor` — what it can't read (a shell script, a Makefile) it doesn't report.
 */
export function testRunners(root: string, commands: string[]): TestRunner[] {
  return commands.flatMap((command) => runnersOf(root, command, command, '.', 0));
}

function runnersOf(root: string, command: string, text: string, startDir: string, depth: number): TestRunner[] {
  let dir = startDir;
  const found: TestRunner[] = [];
  for (const part of text.split(/&&|\|\||;/).map((piece) => piece.trim())) {
    const words = part.split(/\s+/).filter(Boolean);
    const [head, ...args] = words;
    if (!head) continue;
    if (head === 'cd' && args[0]) {
      dir = path.posix.normalize(path.posix.join(dir, args[0]));
    } else if (/(^|\/)(gradlew|gradle)$/.test(head)) {
      found.push({ runner: 'gradle', command, dir, junit: true, sample: path.posix.join(dir, 'build/test-results/test/TEST-Example.xml') });
    } else if (/(^|\/)(mvnw|mvn)$/.test(head)) {
      found.push({ runner: 'maven', command, dir, junit: true, sample: path.posix.join(dir, 'target/surefire-reports/TEST-Example.xml') });
    } else if (['npm', 'pnpm', 'yarn'].includes(head) && depth < MAX_SCRIPT_DEPTH) {
      const script = scriptOf(args);
      const packageDir = workspaceOf(args) ? path.posix.join(dir, workspaceOf(args)!) : dir;
      const body = script && readScripts(path.join(root, packageDir))[script];
      // `npm run test -- --reporter=junit`: what follows `--` reaches the script
      const passed = args.includes('--') ? args.slice(args.indexOf('--') + 1).join(' ') : '';
      if (typeof body === 'string') found.push(...runnersOf(root, command, `${body} ${passed}`.trim(), packageDir, depth + 1));
    } else {
      const js = jsRunner(words);
      if (js) found.push(jsReports(root, command, dir, js, part));
    }
  }
  return found;
}

/** `npm test`, `npm run test`, `yarn test`, `pnpm run test -- --x` → `test`; `npm ci` and the like → none. */
function scriptOf(args: string[]): string | undefined {
  const ownArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  const [first, second] = ownArgs.filter((arg) => !arg.startsWith('-'));
  if (first === 'run' || first === 'run-script') return second;
  return first && ['test', 'start'].includes(first) ? first : undefined;
}

function workspaceOf(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '-w' || arg === '--workspace') return args[index + 1];
    const inline = /^--workspace=(.+)$/.exec(arg);
    if (inline) return inline[1];
  }
  return undefined;
}

function readScripts(packageDir: string): Record<string, unknown> {
  try {
    return (JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return {};
  }
}

/** `vitest run`, `npx vitest`, `CI=1 jest --ci`, `playwright test`; watch and UI modes aren't test runs. */
function jsRunner(words: string[]): 'vitest' | 'jest' | 'playwright' | undefined {
  const command = words.slice(words.findIndex((word) => !/^\w+=/.test(word)));
  const bare = command[0] === 'npx' || command[0] === 'pnpx' ? command.slice(1) : command;
  const [head, sub] = bare;
  if (head === 'vitest' && sub !== 'watch' && sub !== 'dev') return 'vitest';
  if (head === 'jest' && !bare.includes('--watch')) return 'jest';
  if (head === 'playwright' && sub === 'test' && !bare.includes('--ui')) return 'playwright';
  return undefined;
}

const CONFIG_FILES: Record<'vitest' | 'jest' | 'playwright', RegExp> = {
  vitest: /^(vitest|vite)\.config\.[cm]?[jt]s$/,
  jest: /^jest\.config\.[cm]?[jt]s$|^jest\.config\.json$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/,
};

/** A `junit` reporter on the command line or in the runner's config (`jest-junit`, `reporters: ['junit']`), and its `outputFile`. */
function jsReports(root: string, command: string, dir: string, runner: 'vitest' | 'jest' | 'playwright', line: string): TestRunner {
  const packageDir = path.join(root, dir);
  const configs = safeReaddir(packageDir)
    .filter((file) => CONFIG_FILES[runner].test(file))
    .map((file) => fs.readFileSync(path.join(packageDir, file), 'utf8'));
  if (runner === 'jest') configs.push(JSON.stringify((readPackage(packageDir) as { jest?: unknown }).jest ?? ''));
  const texts = [line, ...configs];
  const junit = texts.some((text) => /junit/.test(text));
  const outputFile = texts.map((text) => outputFileOf(text)).find(Boolean) ?? (runner === 'jest' && junit ? 'junit.xml' : undefined);
  return { runner, command, dir, junit, ...(outputFile && { sample: path.posix.normalize(path.posix.join(dir, outputFile)) }) };
}

/** `--outputFile=x`, `--outputFile x`, `outputFile: 'x'`, `outputFile: { junit: 'x' }`, `JEST_JUNIT_OUTPUT_FILE=x`. */
function outputFileOf(text: string): string | undefined {
  const patterns = [
    /--outputFile(?:\.junit)?[=\s]+["']?([^\s"']+)/,
    /outputFile\s*:\s*\{[^}]*junit\s*:\s*["']([^"']+)["']/,
    /outputFile\s*:\s*["']([^"']+)["']/,
    /JEST_JUNIT_OUTPUT_FILE=["']?([^\s"']+)/,
    /PLAYWRIGHT_JUNIT_OUTPUT_FILE=["']?([^\s"']+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1]!.replace(/^\.\//, '');
  }
  return undefined;
}

function readPackage(packageDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Runners whose tests the gates won't see: no JUnit XML, or one outside `glob`. The same runner in one dir is reported once. */
export interface UnreportedRunner {
  runner: TestRunner;
  why: 'no-junit' | 'outside-glob';
}

export function unreportedRunners(runners: TestRunner[], glob: string): UnreportedRunner[] {
  const matches = picomatch(glob);
  const seen = new Set<string>();
  return runners.flatMap((runner): UnreportedRunner[] => {
    const key = `${runner.runner}@${runner.dir}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (!runner.junit) return [{ runner, why: 'no-junit' }];
    if (runner.sample && !matches(runner.sample.replace(/^\.\//, ''))) return [{ runner, why: 'outside-glob' }];
    return [];
  });
}
