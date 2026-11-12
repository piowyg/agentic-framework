// What in a repo starts containers in its tests (Testcontainers, `docker compose`): in `sandbox.mode: container` those
// tests need `sandbox.containers: true`, on the host a running Docker or Podman. A heuristic for `doctor` and `init`:
// a dependency declared under another name (a company library wrapping Testcontainers) it doesn't see.

import fs from 'node:fs';
import path from 'node:path';

const BUILD_FILES = new Set(['build.gradle', 'build.gradle.kts', 'libs.versions.toml', 'pom.xml', 'package.json']);
/** Build output, dependencies and VCS: a match there is someone else's build, not this repo's tests. */
const SKIPPED_DIRS = new Set(['.git', '.gradle', '.idea', 'node_modules', 'build', 'target', 'dist', 'out']);
/** Deep enough for `services/orders/build.gradle`; a repo deeper than that is rare and the walk stays cheap. */
const MAX_DEPTH = 3;

const TESTCONTAINERS = /testcontainers/i;
/** The Gradle plugin `com.avast.gradle.docker-compose`, or a build calling `docker compose` / `docker-compose`. */
const COMPOSE = /docker[ -]compose/i;
const CONTAINER_COMMAND = /\b(docker|podman)\b/;

/** Only the global config (or a registered workspace) sets `sandbox`: a repo can't loosen its own isolation. */
export const CONTAINERS_FIX =
  '`sandbox.containers: true` in ~/.agentic/config.yaml (or in a workspace from the `workspaces` list; a repo config cannot set `sandbox`); container isolation is weaker then (docs/en/security.md)';

/** `<path> (Testcontainers)`, `<path> (docker compose)` and checks that call `docker`/`podman`, sorted by path. */
export function containerTestSignals(root: string, checks: string[]): string[] {
  const files = buildFiles(root, '', 0).flatMap((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (TESTCONTAINERS.test(text)) return [`${file} (Testcontainers)`];
    if (COMPOSE.test(text)) return [`${file} (docker compose)`];
    return [];
  });
  return [...files.sort(), ...checks.filter((command) => CONTAINER_COMMAND.test(command)).map((command) => `\`${command}\` (review.checks)`)];
}

function buildFiles(root: string, dir: string, depth: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isFile()) return BUILD_FILES.has(entry.name) ? [relative] : [];
    if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) return buildFiles(root, relative, depth + 1);
    return [];
  });
}
