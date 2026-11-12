// Deterministic signals from a diff for the reviewer and the gate: hints, never blocking on their own.

/** A test file by its path, across the usual layouts and naming conventions. */
const TEST_FILE = /(^|\/)(src\/test|tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|IT|Spec)\.(java|kt|groovy|scala)$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;

/** File reading APIs of the common test stacks. */
const READ_API = /\b(readFileSync|readFile|readText|readString|readAllLines|readAllBytes|readLines|lines|newBufferedReader|FileReader|FileInputStream|getResourceAsStream|open|read_text|read_bytes|ReadFile|File|Path\.of|Paths\.get)\s*\(/;

/** A string literal that names production code: a JVM source tree or a source file outside tests and resources. */
const SOURCE_LITERAL = /["'`](?:[^"'`]*\/)?(?:src\/main\/(?:java|kotlin|scala|groovy)\/[^"'`]*|(?:src|lib|app)\/(?!test|main\/resources)[^"'`]*\.(?:java|kt|scala|groovy|[cm]?[jt]sx?|py|go|rb|cs|php))["'`]/;

export interface SourceRead {
  file: string;
  line: number;
  code: string;
}

/**
 * Lines a diff adds to test files that read production source through a file API (`AG-TQ-05`: a test runs the code,
 * it doesn't grep it). Takes `git diff -U0` output.
 */
export function sourceReads(diff: string): SourceRead[] {
  const reads: SourceRead[] = [];
  let file: string | undefined;
  let line = 0;
  for (const text of diff.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(text);
    if (header) {
      file = header[1] === '/dev/null' ? undefined : header[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!text.startsWith('+') || text.startsWith('+++')) continue;
    const code = text.slice(1);
    if (file && TEST_FILE.test(file) && READ_API.test(code) && SOURCE_LITERAL.test(code)) reads.push({ file, line, code: code.trim() });
    line++;
  }
  return reads;
}

/** The signal as one warning: where, and the rule it may break. */
export function sourceReadsWarning(reads: SourceRead[]): string | undefined {
  if (!reads.length) return undefined;
  const shown = reads.slice(0, 5).map((read) => `${read.file}:${read.line}`);
  const more = reads.length > shown.length ? ` and ${reads.length - shown.length} more` : '';
  return `tests read source code as a file (AG-TQ-05?): ${shown.join(', ')}${more}`;
}
