import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { casesOf, casesOfFile, clearReports, findReports, parseJUnit, readReports, type TestCase } from '../src/orchestrator/test-reports.js';
import { tmpDir, write } from './helpers.js';

/** As Gradle writes it for JUnit 5: method names with `()`, display names as they are. */
const GRADLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.shop.CartTest" tests="4" skipped="1" failures="1" errors="1">
  <properties/>
  <testcase name="AC-1 opens an empty cart" classname="com.shop.CartTest" time="0.01">
    <failure message="expected: &lt;0&gt; but was: &lt;null&gt;&#10;at line 3" type="org.opentest4j.AssertionFailedError">stack</failure>
  </testcase>
  <testcase name="ac2_rejectsNegativeQuantity()" classname="com.shop.CartTest" time="0.0">
    <error message="java.lang.UnsupportedOperationException: not implemented" type="java.lang.UnsupportedOperationException"><![CDATA[<failure/> inside cdata]]></error>
  </testcase>
  <testcase name="legacyTotal()" classname="com.shop.CartTest" time="0.0"/>
  <testcase name="AC-3 later" classname="com.shop.CartTest$Nested" time="0.0"><skipped/></testcase>
  <system-out><![CDATA[<testcase name="not a test"/>]]></system-out>
</testsuite>
`;

/** As vitest's `junit` reporter writes it: `describe > test`, `>` unescaped in attributes. */
const VITEST = `<testsuites><testsuite name="test/cart.test.ts">
<testcase classname="test/cart.test.ts" name="cart > AC-1 opens" file="test/cart.test.ts"><failure message="expected 0"/></testcase>
<testcase classname='test/other.test.ts' name='other > AC-1 opens' file='test/other.test.ts'></testcase>
</testsuite></testsuites>`;

describe('JUnit XML reports', () => {
  it('reads every test case with its status; failures and errors are told apart', () => {
    expect(parseJUnit(GRADLE)).toEqual([
      { classname: 'com.shop.CartTest', name: 'AC-1 opens an empty cart', status: 'failed', message: 'expected: <0> but was: <null>' },
      { classname: 'com.shop.CartTest', name: 'ac2_rejectsNegativeQuantity()', status: 'error', message: 'java.lang.UnsupportedOperationException: not implemented' },
      { classname: 'com.shop.CartTest', name: 'legacyTotal()', status: 'passed' },
      { classname: 'com.shop.CartTest$Nested', name: 'AC-3 later', status: 'skipped' },
    ]);
    expect(parseJUnit(VITEST).map((testCase) => [testCase.name, testCase.file, testCase.status])).toEqual([
      ['cart > AC-1 opens', 'test/cart.test.ts', 'failed'],
      ['other > AC-1 opens', 'test/other.test.ts', 'passed'],
    ]);
  });

  it('finds a listed test by its name, preferring cases from its own file', () => {
    const gradle = parseJUnit(GRADLE);
    const named = (cases: TestCase[]) => cases.map((testCase) => testCase.name);
    expect(named(casesOf({ path: 'src/test/java/com/shop/CartTest.java', name: 'ac2_rejectsNegativeQuantity' }, gradle))).toEqual(['ac2_rejectsNegativeQuantity()']);
    // a nested class still belongs to the file
    expect(named(casesOf({ path: 'src/test/java/com/shop/CartTest.java', name: 'AC-3 later' }, gradle))).toEqual(['AC-3 later']);
    expect(casesOf({ path: 'src/test/java/com/shop/CartTest.java', name: 'AC-9' }, gradle)).toEqual([]);
    const vitest = parseJUnit(VITEST);
    expect(named(casesOf({ path: 'test/cart.test.ts', name: 'AC-1 opens' }, vitest))).toEqual(['cart > AC-1 opens']);
    // no case from the file: every case with the name
    expect(named(casesOf({ path: 'test/moved.test.ts', name: 'AC-1 opens' }, vitest))).toHaveLength(2);
  });

  it("the cases of a test's file, whatever their names — a vitest report without `file` names it in `classname`", () => {
    const names = (cases: TestCase[]) => cases.map((testCase) => testCase.name);
    expect(names(casesOfFile({ path: 'src/test/java/com/shop/CartTest.java', name: 'renamed' }, parseJUnit(GRADLE)))).toHaveLength(4);
    const noFile = parseJUnit('<testsuite><testcase classname="src/lib/cart.test.ts" name="cart > AC-1 opens"/></testsuite>');
    expect(names(casesOfFile({ path: './src/lib/cart.test.ts', name: 'renamed' }, noFile))).toEqual(['cart > AC-1 opens']);
    expect(casesOfFile({ path: 'src/lib/other.test.ts', name: 'AC-1 opens' }, noFile)).toEqual([]);
  });

  it('Playwright names the file relative to its testDir in `classname`: matched by suffix, never by a test of another file', () => {
    const names = (cases: TestCase[]) => cases.map((testCase) => testCase.name);
    const playwright = parseJUnit(
      [
        '<testsuites><testsuite name="admin-courses.spec.ts">',
        '<testcase classname="admin-courses.spec.ts" name="AC-1 removes a material from a course"/>',
        '</testsuite><testsuite name="admin-reviews.spec.ts">',
        '<testcase classname="admin-reviews.spec.ts" name="AC-1 removes a material from a course with undo"/>',
        '</testsuite></testsuites>',
      ].join(''),
    );
    const courses = { path: 'frontend/e2e/admin-courses.spec.ts', name: 'AC-1 removes a material from a course' };
    expect(names(casesOfFile(courses, playwright))).toEqual(['AC-1 removes a material from a course']);
    expect(names(casesOf(courses, playwright))).toEqual(['AC-1 removes a material from a course']);
    expect(casesOfFile({ path: 'frontend/e2e/other-admin-courses.spec.ts', name: 'x' }, playwright)).toEqual([]);
    // the test's own file is in the report without it: a same-titled test elsewhere is not it
    expect(casesOf({ path: 'frontend/e2e/admin-courses.spec.ts', name: 'AC-1 removes a material from a course with undo' }, playwright)).toEqual([]);
  });

  it('collects the reports matching the glob, never from dependencies or .git; clears them before a run', () => {
    const root = tmpDir();
    write(root, 'build/test-results/test/TEST-a.xml', GRADLE);
    write(root, 'app/build/test-results/test/TEST-b.xml', VITEST);
    write(root, 'node_modules/lib/build/test-results/test/TEST-c.xml', GRADLE);
    write(root, 'build/test-results/test/binary/output.bin', 'x');
    const glob = '**/build/test-results/test/*.xml';
    expect(findReports(root, glob)).toEqual(['app/build/test-results/test/TEST-b.xml', 'build/test-results/test/TEST-a.xml']);
    expect(readReports(root, glob)).toHaveLength(6);
    clearReports(root, glob);
    expect(readReports(root, glob)).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'node_modules/lib/build/test-results/test/TEST-c.xml'))).toBe(true);
  });
});
