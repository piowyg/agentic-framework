import { seconds } from '../orchestrator/checks.js';

const CLEAR_LINE = '\r\x1b[2K';
const TICK_MS = 1000;

/**
 * The line of what runs now (a check command), under the log on a terminal, with the time it has taken so far;
 * finished, it gives way to the log's own line (acceptance smoke, finding 16). Lines logged meanwhile go above it.
 * Off a terminal there is no live line: the log alone, as before.
 */
export class LiveLine {
  private readonly running = new Map<string, { line: string; startedAt: number }>();
  private shown = false;
  private suspended = 0;
  /** Logged while a gate had the terminal: written once it is answered. */
  private held: string[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly output: NodeJS.WriteStream = process.stdout,
    private readonly now: () => number = Date.now,
  ) {}

  /** A line for good: the live one is cleared first and drawn again below it. */
  say(text: string): void {
    if (this.suspended) {
      this.held.push(text);
      return;
    }
    this.clear();
    this.output.write(`${text}\n`);
    this.draw();
  }

  /** `line` starts running under `id`; without a line, what ran under `id` has finished. */
  progress(id: string, line?: string): void {
    if (!this.output.isTTY) return;
    if (line) this.running.set(id, { line, startedAt: this.now() });
    else this.running.delete(id);
    this.clear();
    this.draw();
    if (this.running.size && !this.timer) {
      this.timer = setInterval(() => {
        this.clear();
        this.draw();
      }, TICK_MS);
      this.timer.unref();
    } else if (!this.running.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Nothing drawn or logged while `work` has the terminal (a gate's menu, its note): a parallel group's log would
   * land inside the question (smoke after #65, finding 3). What was logged meanwhile follows the answer.
   */
  async aside<Result>(work: () => Promise<Result>): Promise<Result> {
    this.clear();
    this.suspended++;
    try {
      return await work();
    } finally {
      this.suspended--;
      if (!this.suspended) for (const text of this.held.splice(0)) this.output.write(`${text}\n`);
      this.draw();
    }
  }

  private draw(): void {
    // the latest to start: parallel groups share the one line
    const latest = [...this.running.values()].at(-1);
    if (!latest || this.suspended || this.shown) return;
    const text = `${latest.line} (${seconds(this.now() - latest.startedAt)})`;
    // a wrapped line can't be cleared with \r
    const width = (this.output.columns || 80) - 1;
    this.output.write(text.length > width ? `${text.slice(0, width - 1)}…` : text);
    this.shown = true;
  }

  private clear(): void {
    if (!this.shown) return;
    this.output.write(CLEAR_LINE);
    this.shown = false;
  }
}
