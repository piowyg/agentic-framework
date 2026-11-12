import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomic write that a planted symlink can't redirect: O_EXCL temp file, then rename
 * (rename replaces the link itself, not its target). `durable` also fsyncs the file and its directory.
 */
export function writeFileSafe(file: string, content: string, options: { durable?: boolean } = {}): void {
  const tempFile = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fileDescriptor = fs.openSync(tempFile, 'wx');
  try {
    fs.writeSync(fileDescriptor, content);
    if (options.durable) fs.fsyncSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
  fs.renameSync(tempFile, file);
  if (options.durable) syncDir(path.dirname(file));
}

/** Persists the rename itself; not supported on every platform, so best effort. */
function syncDir(dir: string): void {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(dir, 'r');
    fs.fsyncSync(fileDescriptor);
  } catch {
    // e.g. EISDIR/EPERM on some filesystems
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

/** Append without following symlinks. */
export function appendFileSafe(file: string, content: string): void {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
  const fileDescriptor = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
  try {
    fs.writeSync(fileDescriptor, content);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export interface ReadSafeOptions {
  /** Refuses larger files without reading them. */
  maxBytes?: number;
  /** A missing file returns undefined instead of throwing. */
  missingOk?: boolean;
}

/** Artifacts come from agents: refuse symlinks and anything that isn't a regular file. */
export function readFileSafe(file: string, label?: string, options?: ReadSafeOptions & { missingOk?: false }): string;
export function readFileSafe(file: string, label: string, options: ReadSafeOptions): string | undefined;
export function readFileSafe(file: string, label = file, options: ReadSafeOptions = {}): string | undefined {
  const { O_RDONLY, O_NOFOLLOW } = fs.constants;
  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`${label}: symlink not allowed`);
    if (code === 'ENOENT' && options.missingOk) return undefined;
    throw error;
  }
  try {
    const stats = fs.fstatSync(fileDescriptor);
    if (!stats.isFile()) throw new Error(`${label}: not a regular file`);
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
      throw new Error(`${label}: file too large (${stats.size} B, limit ${options.maxBytes} B)`);
    }
    return fs.readFileSync(fileDescriptor, 'utf8');
  } finally {
    fs.closeSync(fileDescriptor);
  }
}
