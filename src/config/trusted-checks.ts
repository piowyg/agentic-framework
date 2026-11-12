import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFileSafe } from '../fsutil.js';

/**
 * Consent to run a repo's `review.checks` and `review.compile` on the host: `./gradlew test` executes
 * build scripts the agent may have changed. Kept per repo and per exact command list, so a changed list asks again.
 */
interface TrustFile {
  repos?: Record<string, { hash: string; commands: string[]; trusted_at: string }>;
}

export function trustFile(globalDir: string): string {
  return path.join(globalDir, 'trusted-checks.yaml');
}

export function checksHash(commands: string[]): string {
  return createHash('sha256').update(JSON.stringify(commands)).digest('hex');
}

export function checksTrusted(globalDir: string, repoRoot: string, commands: string[]): boolean {
  return read(globalDir).repos?.[path.resolve(repoRoot)]?.hash === checksHash(commands);
}

export function trustChecks(globalDir: string, repoRoot: string, commands: string[], now = new Date()): void {
  const content = read(globalDir);
  content.repos = { ...content.repos, [path.resolve(repoRoot)]: { hash: checksHash(commands), commands, trusted_at: now.toISOString() } };
  fs.mkdirSync(globalDir, { recursive: true });
  writeFileSafe(trustFile(globalDir), stringify(content));
}

/** A broken file trusts nothing; the next consent rewrites it. */
function read(globalDir: string): TrustFile {
  const file = trustFile(globalDir);
  if (!fs.existsSync(file)) return {};
  try {
    const content = parse(fs.readFileSync(file, 'utf8')) as TrustFile | null;
    return content && typeof content === 'object' ? content : {};
  } catch {
    return {};
  }
}
