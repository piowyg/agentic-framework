import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Works from both src/ (tsx) and dist/. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let version: string | undefined;

export function frameworkVersion(): string {
  version ??= (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  return version;
}

/** Written by every `npm run build`. */
const BUILT_ENTRY = path.join('dist', 'cli', 'main.js');

const RUNS_FROM_DIST = fileURLToPath(import.meta.url).split(path.sep).includes('dist');

/**
 * A linked checkout (`npm link`) run from `dist/` whose `src/` changed after the last build: flows would run older
 * code than the checkout shows — on a pilot flow such a build skipped the stronger tasks a fix already reviews.
 * Undefined for an installed package (no `src/`) and under tsx.
 */
export function staleBuild(root = PACKAGE_ROOT, fromDist = RUNS_FROM_DIST): { built: Date; changed: Date } | undefined {
  const entry = path.join(root, BUILT_ENTRY);
  const sources = path.join(root, 'src');
  if (!fromDist || !fs.existsSync(entry) || !fs.existsSync(sources)) return undefined;
  const built = fs.statSync(entry).mtime;
  const changed = newestChange(sources);
  return changed > built ? { built, changed } : undefined;
}

function newestChange(dir: string): Date {
  let newest = new Date(0);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestChange(file) : fs.statSync(file).mtime;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** What doctor and a flow start say about a stale build, with the command that fixes it. */
export function staleBuildWarning(stale: { built: Date; changed: Date }, root = PACKAGE_ROOT): { detail: string; fix: string } {
  return {
    detail: `agentic built ${localTime(stale.built)}, but src/ changed ${localTime(stale.changed)}; flows will run older code`,
    fix: `cd "${root}" && npm run build`,
  };
}

function localTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
