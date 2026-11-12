import picomatch from 'picomatch';

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
}

export interface MergeDanger {
  door: 'one-way' | 'two-way';
  /** Changed files matching `publish.one_way_paths`, with the pattern that caught each. */
  oneWay: Array<{ path: string; pattern: string }>;
  /** Top-level directories the change touches (`.` for files at the root), most lines first. */
  areas: string[];
  files: number;
  added: number;
  deleted: number;
}

/**
 * Deterministic flags from the diff: a revert brings back the code, not what a migration or
 * a changed contract already did. Blast radius as the areas touched; dependent modules come with the repo map (planned).
 */
export function mergeDanger(files: ChangedFile[], oneWayPaths: string[]): MergeDanger {
  const matchers = oneWayPaths.map((pattern) => ({ pattern, test: picomatch(pattern, { dot: true }) }));
  const oneWay = files.flatMap((file) => {
    const match = matchers.find((matcher) => matcher.test(file.path));
    return match ? [{ path: file.path, pattern: match.pattern }] : [];
  });
  const lines = new Map<string, number>();
  for (const file of files) {
    const area = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '.';
    lines.set(area, (lines.get(area) ?? 0) + file.added + file.deleted);
  }
  return {
    door: oneWay.length ? 'one-way' : 'two-way',
    oneWay,
    areas: [...lines.entries()].sort((left, right) => right[1] - left[1]).map(([area]) => area),
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
  };
}

/** `git diff --numstat -z`: `added\tdeleted\tpath\0`, a rename `added\tdeleted\t\0from\0to\0`; binary files count 0. */
export function parseNumstat(output: string): ChangedFile[] {
  const fields = output.split('\0');
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index]!);
    if (!match) continue;
    let filePath = match[3]!;
    if (!filePath) {
      filePath = fields[index + 2] ?? '';
      index += 2;
    }
    files.push({ path: filePath, added: Number(match[1]) || 0, deleted: Number(match[2]) || 0 });
  }
  return files;
}
