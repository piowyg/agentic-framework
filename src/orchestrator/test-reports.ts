import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/** `failed` is an assertion; `error` an exception before or instead of one (JUnit's `<error>`). */
export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** One `<testcase>` of a JUnit XML report (Gradle, Maven Surefire, jest-junit, vitest's `junit` reporter). */
export interface TestCase {
  classname: string;
  name: string;
  /** Set by some JS reporters; Java ones name the class instead. */
  file?: string;
  status: TestStatus;
  /** The first line of the failure, error or skip message. */
  message?: string;
}

/** A test as `write-tests.json` lists it. */
export interface TestRef {
  path: string;
  name: string;
}

/** Never searched for reports: other repos' or dependencies' reports would pass for the clone's. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

const ATTRIBUTES = String.raw`((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*`;
const TEST_CASE = new RegExp(String.raw`<testcase\b${ATTRIBUTES}(?:/>|>([\s\S]*?)</testcase\s*>)`, 'g');
const OUTCOME = new RegExp(String.raw`<(failure|error|skipped)\b${ATTRIBUTES}/?>`);
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The test cases of one report; what isn't a `<testcase>` (suites, properties, output) is ignored. */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  // output captured in CDATA may itself contain XML, test cases included
  const text = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const match of text.matchAll(TEST_CASE)) {
    const attributes = parseAttributes(match[1] ?? '');
    const outcome = OUTCOME.exec(match[2] ?? '');
    const message = outcome && parseAttributes(outcome[2] ?? '').message?.split('\n')[0]?.trim();
    cases.push({
      classname: attributes.classname ?? '',
      name: attributes.name ?? '',
      ...(attributes.file && { file: attributes.file }),
      status: !outcome ? 'passed' : outcome[1] === 'failure' ? 'failed' : (outcome[1] as 'error' | 'skipped'),
      ...(message && { message }),
    });
  }
  return cases;
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? '');
  return attributes;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (_entity, code: string) => {
    if (code[0] === '#') return String.fromCodePoint(code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[code.toLowerCase()]!;
  });
}

/** Report files under `root` matching `glob` (relative to it), sorted. */
export function findReports(root: string, glob: string): string[] {
  const matches = picomatch(glob);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
        if (matches(relative)) found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Reports of an earlier run would pass for the next one's: removed before the tests run. */
export function clearReports(root: string, glob: string): void {
  for (const file of findReports(root, glob)) fs.rmSync(path.join(root, file), { force: true });
}

/** Every test case of the matching reports; `undefined` when no report matched (the gates then fall back to exit codes). */
export function readReports(root: string, glob: string): TestCase[] | undefined {
  const files = findReports(root, glob);
  if (!files.length) return undefined;
  return files.flatMap((file) => parseJUnit(fs.readFileSync(path.join(root, file), 'utf8')));
}

/** Identity of a test case across runs, for the regression check. */
export function caseKey(testCase: TestCase): string {
  return [testCase.file ?? '', testCase.classname, testCase.name].join('#');
}

/**
 * The report's cases of a listed test: its name inside `classname name` (Gradle appends `()` to method names,
 * JS reporters prefix describe blocks). When some of them also come from the test's file — by the `file`
 * attribute, or a Java class name matching the path — only those.
 */
export function casesOf(test: TestRef, cases: TestCase[]): TestCase[] {
  const name = test.name.trim();
  const named = cases.filter((testCase) => `${testCase.classname} ${testCase.name.replace(/\(\)$/, '')}`.includes(name));
  const fromFile = named.filter((testCase) => fromPath(testCase, test.path));
  return fromFile.length ? fromFile : named;
}

/** The report's cases from the test's file, whatever their names: none means no report has that file at all. */
export function casesOfFile(test: TestRef, cases: TestCase[]): TestCase[] {
  return cases.filter((testCase) => fromPath(testCase, test.path));
}

function fromPath(testCase: TestCase, testPath: string): boolean {
  const normalized = testPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const sameFile = (file: string) => file.endsWith(normalized) || normalized.endsWith(file);
  if (testCase.file) return sameFile(testCase.file.replace(/\\/g, '/'));
  // vitest's junit reporter names the file in `classname`
  if (testCase.classname.includes('/')) return sameFile(testCase.classname.replace(/\\/g, '/').replace(/^\.\//, ''));
  const className = testCase.classname.split('$')[0]!;
  if (!className || /\s/.test(className)) return false;
  const dotted = normalized.replace(/\.[^./]+$/, '').replace(/\//g, '.');
  return dotted === className || dotted.endsWith(`.${className}`);
}
