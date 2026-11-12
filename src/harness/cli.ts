import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HarnessName } from '../config/types.js';
import { modelEntry, type HarnessEntry, type ModelCatalog } from '../config/models.js';
import type { Harness, HarnessCommand, HarnessStatus, ProcessResult, SessionRequest, SessionResult } from './types.js';

const exec = promisify(execFile);

export async function harnessStatus(entry: HarnessEntry): Promise<HarnessStatus> {
  try {
    const { stdout } = await exec(entry.binary, entry.version_args, { timeout: 10_000 });
    return { installed: true, version: /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim() };
  } catch {
    return { installed: false };
  }
}

/** A real harness CLI: the binary and model ids come from the catalog. */
export abstract class CliHarness implements Harness {
  constructor(
    readonly name: HarnessName,
    protected readonly catalog: ModelCatalog,
  ) {}

  status(): Promise<HarnessStatus> {
    return harnessStatus(this.catalog.harnesses[this.name]);
  }

  /** What the CLI signs in with in a container, by name: passed from the host's environment, never by value. */
  protected abstract readonly credentials: readonly string[];

  abstract buildCommand(request: SessionRequest): HarnessCommand;
  abstract parseResult(result: ProcessResult, request: SessionRequest): SessionResult;

  /** The command, with the credentials when the session runs in a container (`HarnessCommand.passEnv`). */
  protected command(request: SessionRequest, command: HarnessCommand): HarnessCommand {
    return request.isolated ? { ...command, passEnv: this.credentials } : command;
  }

  protected get binary(): string {
    return this.catalog.harnesses[this.name].binary;
  }

  /** The id the CLI takes for a config alias; the config was validated against the same catalog. */
  protected modelId(alias: string): string {
    const entry = modelEntry(this.catalog, alias);
    if (!entry || entry.harness !== this.name) throw new Error(`model \`${alias}\` does not belong to harness \`${this.name}\``);
    return entry.id;
  }
}

/** Parsed lines of a JSONL stream, typed by the caller; anything else (a stray log line) is skipped. */
export function jsonLines<Event extends { type?: string }>(text: string): Event[] {
  const lines: Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(line) as Event);
    } catch {
      // a truncated last line of a killed process
    }
  }
  return lines;
}

/** The end of stderr, for a session that died without a result. */
export function stderrTail(stderr: string): string {
  return stderr.trim().slice(-2000);
}
