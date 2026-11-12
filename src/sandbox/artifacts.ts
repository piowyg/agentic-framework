import path from 'node:path';
import { readFileSafe, writeFileSafe } from '../fsutil.js';

/** Larger than any ticket, spec or plan; stops a session from filling the disk through the flow directory. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Copies `name` from a session's `out/` into the flow directory — the only way agent output gets next to
 * `state.json`. Only a regular file, no symlink; absent = false, the old copy stays.
 */
export function collectArtifact(outDir: string, name: string, flowDir: string): boolean {
  const content = readArtifact(outDir, name);
  if (content === undefined) return false;
  writeFileSafe(path.join(flowDir, name), content);
  return true;
}

/** Reads `name` from a session's `out/` with the same checks as `collectArtifact`; absent = undefined. */
export function readArtifact(outDir: string, name: string): string | undefined {
  if (path.basename(name) !== name) throw new Error(`artifact \`${name}\`: expected a file name, not a path`);
  return readFileSafe(path.join(outDir, name), name, { maxBytes: MAX_ARTIFACT_BYTES, missingOk: true });
}
