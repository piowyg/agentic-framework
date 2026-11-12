import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSafe } from '../fsutil.js';

/** One orchestrator process per flow directory. */
export function acquireLock(workDir: string): () => void {
  const file = path.join(workDir, '.lock');
  const ownPid = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    // the PID is written before link() publishes the lock, so nobody sees an empty lock file
    const tempFile = `${file}.${ownPid}.tmp`;
    writeFileSafe(tempFile, ownPid);
    try {
      fs.linkSync(tempFile, file);
      return () => {
        if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = readPid(file);
      if (alive(pid)) throw new Error(`The flow is already running (pid ${pid}). If it is not, remove ${file}.`);
      breakStaleLock(file);
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  }
  throw new Error(`Could not take the lock ${file}`);
}

/** False for a flow whose process died: its state.json may still say `running`. */
export function flowRunning(workDir: string): boolean {
  return alive(readPid(path.join(workDir, '.lock')));
}

/**
 * Rename-then-check, so two processes breaking the same stale lock can't delete each other's fresh one:
 * whoever renamed a live lock puts it back.
 */
function breakStaleLock(file: string): void {
  const staleFile = `${file}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, staleFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const pid = readPid(staleFile);
    if (alive(pid)) {
      fs.linkSync(staleFile, file);
      throw new Error(`The flow is already running (pid ${pid}).`);
    }
  } finally {
    fs.rmSync(staleFile, { force: true });
  }
}

function readPid(file: string): number {
  try {
    return Number(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
