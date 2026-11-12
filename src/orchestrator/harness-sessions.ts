import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessName } from '../config/types.js';
import { readFileSafe, writeFileSafe } from '../fsutil.js';

/**
 * In a container each session keeps its harness's sessions (`Harness.sessionsHome`) in a host directory of its own,
 * under `work/<slug>/harness/<harness>/`: no session reads another's transcript, nor leaves files a later one loads
 * (Claude Code's auto memory lives next to the transcripts). A resumed session gets back the directory it ran in.
 */
export function harnessSessionsDir(workDir: string, harness: HarnessName, resumeId?: string): string {
  const root = path.join(workDir, 'harness', harness);
  const resume = fileName(resumeId);
  const known = resume && fileName(readFileSafe(idFile(root, resume), resume, { missingOk: true })?.trim());
  const dir = path.join(root, known || randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The harness's id of a session that ran in `dir`, for `harnessSessionsDir` to find on resume. */
export function rememberSessionDir(dir: string, sessionId: string): void {
  const id = fileName(sessionId);
  if (!id) return;
  const file = idFile(path.dirname(dir), id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileSafe(file, path.basename(dir));
}

/** A session id or a directory name read back, when safe as one path segment; undefined otherwise. */
function fileName(value: string | undefined): string | undefined {
  return value && /^[\w-]{1,100}$/.test(value) ? value : undefined;
}

function idFile(root: string, sessionId: string): string {
  return path.join(root, 'ids', sessionId);
}
