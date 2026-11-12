import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults.js';
import { diffSize, generatedFiles, sizeWarning } from '../src/publish/size.js';
import { committedRepo, tmpDir, git } from './helpers.js';

const SIZE = DEFAULTS.publish.size;

describe('publish: size', () => {
  it('splits added + deleted into production, tests and excluded; docs count as production', () => {
    const size = diffSize(
      [
        { path: 'backend/src/main/java/Cart.java', added: 120, deleted: 30 },
        { path: 'backend/src/test/java/CartTest.java', added: 200, deleted: 0 },
        { path: 'frontend/src/App.test.tsx', added: 40, deleted: 10 },
        { path: 'frontend/package-lock.json', added: 3000, deleted: 900 },
        { path: 'api/gen/generated/Client.ts', added: 500, deleted: 0 },
        { path: 'docs/usage.md', added: 15, deleted: 5 },
        { path: 'proto/client_pb2.py', added: 77, deleted: 0 },
      ],
      SIZE,
    );
    expect(size).toEqual({ prod: 170, tests: 250, excluded: 4477, over: [], limits: { prod: 400, total: 800 } });
  });

  it('a file marked generated in .gitattributes is excluded like a lockfile', () => {
    const files = [
      { path: 'src/schema.ts', added: 900, deleted: 0 },
      { path: 'src/app.ts', added: 10, deleted: 0 },
    ];
    expect(diffSize(files, SIZE, new Set(['src/schema.ts']))).toMatchObject({ prod: 10, excluded: 900 });
  });

  it('over either threshold is a warning, named by threshold', () => {
    const limits = { ...SIZE, max_prod_lines: 100, max_total_lines: 150 };
    expect(diffSize([{ path: 'src/a.ts', added: 101, deleted: 0 }], limits).over).toEqual(['prod']);
    expect(diffSize([{ path: 'src/a.ts', added: 90, deleted: 0 }, { path: 'src/a.test.ts', added: 61, deleted: 0 }], limits).over).toEqual(['total']);
    expect(diffSize([{ path: 'src/a.ts', added: 100, deleted: 0 }, { path: 'src/a.test.ts', added: 50, deleted: 0 }], limits).over).toEqual([]);
  });

  it('a layer replaces the test and exclude globs, it does not add to them', () => {
    const size = diffSize(
      [
        { path: 'spec/cart_spec.rb', added: 30, deleted: 0 },
        { path: 'src/a.test.ts', added: 7, deleted: 0 },
        { path: 'package-lock.json', added: 5, deleted: 0 },
      ],
      { ...SIZE, tests: ['spec/**'], exclude: [] },
    );
    expect(size).toMatchObject({ prod: 12, tests: 30, excluded: 0 });
  });

  it('reads linguist-generated from the .gitattributes of the commit, not the working tree', () => {
    const repo = committedRepo(path.join(tmpDir(), 'repo'));
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'src/schema.ts linguist-generated\nvendor/** linguist-generated=true\nsrc/keep.ts -linguist-generated\n');
    git(repo, ['add', '.gitattributes']);
    git(repo, ['commit', '-qm', 'attributes']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'src/app.ts linguist-generated\n');

    expect(generatedFiles(repo, head, ['src/schema.ts', 'vendor/lib/x.js', 'src/keep.ts', 'src/app.ts'])).toEqual(new Set(['src/schema.ts', 'vendor/lib/x.js']));
    expect(generatedFiles(repo, head, [])).toEqual(new Set());
  });

  it('finds the generated file among more paths than fit on one command line', () => {
    const repo = committedRepo(path.join(tmpDir(), 'repo'));
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'gen/** linguist-generated\n');
    git(repo, ['add', '.gitattributes']);
    git(repo, ['commit', '-qm', 'attributes']);
    const deep = 'module/'.repeat(12);
    const paths = Array.from({ length: 20_000 }, (_, index) => `${deep}File${index}.java`);

    expect(generatedFiles(repo, git(repo, ['rev-parse', 'HEAD']), [...paths, 'gen/Client.ts'])).toEqual(new Set(['gen/Client.ts']));
  });

  describe('a group measured against its estimate', () => {
    const limits = { prod: 400, total: 800 };

    it('warns when the measured diff crosses a threshold the estimate stayed under', () => {
      expect(sizeWarning({ prod: 900, tests: 100 }, { prod: 300, tests: 50 }, limits)).toBe(
        'over the publish.size threshold (400 prod, 800 with tests): 900 prod / 100 test, planned ~300 prod / 50 test',
      );
      expect(sizeWarning({ prod: 300, tests: 600 }, { prod: 300, tests: 50 }, limits)).toMatch(/^over the publish.size threshold/);
    });

    it('stays quiet under the thresholds, however far from the estimate', () => {
      expect(sizeWarning({ prod: 400, tests: 400 }, { prod: 20, tests: 10 }, limits)).toBeUndefined();
    });

    it('a threshold the plan already crossed, with its reason, is no news', () => {
      expect(sizeWarning({ prod: 700, tests: 50 }, { prod: 500, tests: 50 }, limits)).toBeUndefined();
      expect(sizeWarning({ prod: 700, tests: 300 }, { prod: 500, tests: 50 }, limits)).toMatch(/^over the publish.size threshold/);
    });

    it('over a threshold the plan crossed: news once the diff is past twice the estimate its oversize_reason covered', () => {
      expect(sizeWarning({ prod: 1000, tests: 400 }, { prod: 500, tests: 400 }, limits)).toBeUndefined();
      expect(sizeWarning({ prod: 1001, tests: 400 }, { prod: 500, tests: 400 }, limits)).toBe(
        'over 2× the estimate behind oversize_reason: 1001 prod / 400 test, planned ~500 prod / 400 test',
      );
    });

    it('the production with tests threshold the plan crossed: twice its estimated total', () => {
      expect(sizeWarning({ prod: 300, tests: 1500 }, { prod: 300, tests: 600 }, limits)).toBeUndefined();
      expect(sizeWarning({ prod: 300, tests: 1501 }, { prod: 300, tests: 600 }, limits)).toBe(
        'over 2× the estimate behind oversize_reason: 300 prod / 1501 test, planned ~300 prod / 600 test',
      );
    });

    it('a plan without an estimate: any threshold crossed is a warning', () => {
      expect(sizeWarning({ prod: 401, tests: 0 }, undefined, limits)).toBe('over the publish.size threshold (400 prod, 800 with tests): 401 prod / 0 test, the plan had no estimate');
    });
  });
});
