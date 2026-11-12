import { describe, expect, it } from 'vitest';
import { testRunners, unreportedRunners } from '../src/orchestrator/test-runners.js';
import { tmpDir, write } from './helpers.js';

describe('testRunners', () => {
  it('follows `cd`, workspaces and scripts calling scripts down to the runner', () => {
    const root = tmpDir();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'npm run test -w web', ci: 'npm run lint && npm test' } }));
    write(root, 'web/package.json', JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
    const runners = testRunners(root, ['cd api && ./mvnw -B verify', 'npm run ci', '[ -d node_modules ] || npm ci']);
    expect(runners.map(({ runner, dir, junit, sample }) => ({ runner, dir, junit, sample }))).toEqual([
      { runner: 'maven', dir: 'api', junit: true, sample: 'api/target/surefire-reports/TEST-Example.xml' },
      { runner: 'vitest', dir: 'web', junit: false, sample: undefined },
    ]);
  });

  it('a junit reporter on the command line, after `--`, or in the config; watch and UI modes are no test runs', () => {
    const root = tmpDir();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run', e2e: 'playwright test', jest: 'JEST_JUNIT_OUTPUT_FILE=out/jest.xml jest --ci --reporters=jest-junit' } }));
    write(root, 'playwright.config.ts', "export default { reporter: [['junit', { outputFile: 'results/e2e.xml' }]] };\n");
    const found = (command: string) => testRunners(root, [command]).map(({ runner, junit, sample }) => ({ runner, junit, sample }));
    expect(found('npm run test -- --reporter=junit --outputFile=build/vitest.xml')).toEqual([{ runner: 'vitest', junit: true, sample: 'build/vitest.xml' }]);
    expect(found('npm run e2e')).toEqual([{ runner: 'playwright', junit: true, sample: 'results/e2e.xml' }]);
    expect(found('npm run jest')).toEqual([{ runner: 'jest', junit: true, sample: 'out/jest.xml' }]);
    expect(found('npx vitest watch')).toEqual([]);
    expect(found('npx playwright test --ui')).toEqual([]);
  });

  it('unreported: no JUnit at all, or a report outside the glob; one runner in one dir once', () => {
    const root = tmpDir();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    const runners = testRunners(root, ['./gradlew test', './gradlew integration -x test', 'npm test']);
    expect(unreportedRunners(runners, 'build/test-results/**/*.xml').map(({ runner, why }) => [runner.runner, why])).toEqual([['vitest', 'no-junit']]);
    expect(unreportedRunners(runners, 'nowhere/*.xml').map(({ runner, why }) => [runner.runner, why])).toEqual([
      ['gradle', 'outside-glob'],
      ['vitest', 'no-junit'],
    ]);
  });
});
