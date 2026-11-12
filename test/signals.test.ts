import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { sourceReads, sourceReadsWarning } from '../src/review/signals.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

// A test file reading production source as text is a signal for the reviewer and the gate (AG-TQ-05).

const diff = (file: string, ...lines: string[]) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');

describe('sourceReads', () => {
  it('finds test lines that read production source through a file API, in the usual stacks', () => {
    const reads = sourceReads(
      [
        diff('src/test/java/app/HandlerTest.java', 'class HandlerTest {', '  String code = Files.readString(Path.of("src/main/java/app/Handler.java"));', '}'),
        diff('src/post.test.ts', "const source = readFileSync('src/post.ts', 'utf8');", "expect(source).toMatch(/validate/);"),
        diff('tests/test_handler.py', 'text = open("app/handler.py").read()'),
      ].join('\n'),
    );
    expect(reads.map((read) => `${read.file}:${read.line}`)).toEqual(['src/test/java/app/HandlerTest.java:2', 'src/post.test.ts:1', 'tests/test_handler.py:1']);
  });

  it('leaves alone fixtures, resources and production code reading files', () => {
    expect(
      sourceReads(
        [
          diff('src/test/java/app/ImportTest.java', 'String csv = Files.readString(Path.of("src/test/resources/rows.csv"));'),
          diff('src/test/java/app/ConfigTest.java', 'String yaml = Files.readString(Path.of("src/main/resources/application.yml"));'),
          diff('src/post.test.ts', "const fixture = readFileSync(path.join(__dirname, 'fixtures/post.json'), 'utf8');"),
          diff('src/main/java/app/Loader.java', 'String code = Files.readString(Path.of("src/main/resources/app.yaml"));'),
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('one warning for the gate, at most five places', () => {
    const reads = Array.from({ length: 7 }, (_, index) => ({ file: 'src/a.test.ts', line: index + 1, code: 'x' }));
    expect(sourceReadsWarning(reads)).toBe('tests read source code as a file (AG-TQ-05?): src/a.test.ts:1, src/a.test.ts:2, src/a.test.ts:3, src/a.test.ts:4, src/a.test.ts:5 and 2 more');
    expect(sourceReadsWarning([])).toBeUndefined();
  });
});

describe('in the review loop', () => {
  it('the standards reviewer gets the lines to judge and the gate a warning', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry({
      implement: {
        report: { status: 'done', summary: 'ok', tests_added: [] },
        commit: { 'src/main/java/app/Handler.java': 'class Handler {}\n', 'src/test/java/app/HandlerTest.java': 'var code = Files.readString(Path.of("src/main/java/app/Handler.java"));\n' },
      },
    });
    const gates = new ScriptedGates();
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    await runFlow({ workDir, config: { ...TEST_CONFIG, autonomy: 'strict' }, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
    const standards = harnesses.calls().find((call) => call.kind === 'review-standards')!;
    expect(standards.prompt).toContain('src/test/java/app/HandlerTest.java:1: var code = Files.readString');
    expect(harnesses.calls().find((call) => call.kind === 'review-spec')!.prompt).not.toContain('AG-TQ-05');
    expect(gates.seen.find((request) => request.gate === 'group')!.summary).toContain('⚠ tests read source code as a file (AG-TQ-05?): src/test/java/app/HandlerTest.java:1');
  });
});
