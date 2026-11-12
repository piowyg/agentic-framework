import { createInterface, type Interface } from 'node:readline';
import { arrowMenu, type RawInput } from './arrow-menu.js';
import { renderGate, terminalStyles } from './gate-view.js';
import { sanitize } from './sanitize.js';
import type { GateDecider, GateDecision, GateRequest } from '../orchestrator/gates.js';

const LABELS: Record<GateDecision['action'], string> = {
  continue: 'continue',
  push_and_stop: 'push to the tracker and finish',
  stop: 'save and pause (later `agentic resume`)',
  retry: 'fix with a note',
  rollback: 'roll back to a review round',
  manual: "I'll resolve it myself (a clean clone in the conflict state, then `agentic resume`)",
  abort: 'abort the flow',
};

/** Ends a paste in `readText`. */
export const PASTE_END = '.';

/** EOF on stdin means stop. Gates of parallel groups are asked one at a time, in arrival order. */
export class TtyGates implements GateDecider {
  private reader?: Interface;
  private queue: Promise<unknown> = Promise.resolve();
  private lines: string[] = [];
  private waiting?: (line: string | undefined) => void;
  private closed = false;

  /** Menus take arrow keys when stdin and stdout are a terminal; otherwise (pipes, tests) a number per line. */
  private readonly arrows: boolean;

  constructor(
    private readonly input: RawInput = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.arrows = Boolean(input.isTTY && output.isTTY && input.setRawMode);
  }

  decide(request: GateRequest): Promise<GateDecision> {
    const decision = this.queue.then(async () => {
      try {
        return await this.prompt(request);
      } finally {
        this.release();
      }
    });
    this.queue = decision.catch(() => undefined);
    return decision;
  }

  private async prompt(request: GateRequest): Promise<GateDecision> {
    const body = request.view
      ? renderGate(request.gate, request.group, request.view, terminalStyles(), process.stdout.columns)
      : `━━ Gate: ${request.gate}${request.group ? ` (${request.group})` : ''} ━━\n${sanitize(request.summary)}`;
    console.log(`\n${body}\n`);
    const chosen = await this.menu(request.actions.map((action) => LABELS[action]));
    if (chosen === undefined) return { action: 'stop' };
    const action = request.actions[chosen]!;
    if (action === 'retry') {
      const note = await this.ask('Note: ');
      return note === undefined ? { action: 'stop' } : { action, note: note.trim() };
    }
    if (action === 'rollback') {
      const round = await this.askRound(request.rounds ?? []);
      return round === undefined ? { action: 'stop' } : { action, round };
    }
    return { action } as GateDecision;
  }

  /** A yes/no question outside any gate; EOF or anything but yes is no. */
  async confirm(question: string): Promise<boolean> {
    try {
      const answer = await this.ask(`${question} [y/N] `);
      return /^(y|yes)$/i.test(answer?.trim() ?? '');
    } finally {
      this.release();
    }
  }

  /** A list to choose from; the index chosen, or undefined on Esc, an empty answer or EOF. */
  async choose(question: string, items: string[]): Promise<number | undefined> {
    try {
      console.log(`${question} ${this.arrows ? '(↑/↓ and Enter; Esc: none)' : '(number; Enter: none)'}`);
      return await this.menu(items, true);
    } finally {
      this.release();
    }
  }

  /**
   * The index chosen, or undefined for none: EOF (Ctrl-D), and with `optional` Esc or an empty answer.
   * A gate is not optional: a stray Esc doesn't pause the flow. A wrong number asks again.
   */
  private async menu(items: string[], optional = false): Promise<number | undefined> {
    if (this.arrows) {
      // readline would read the raw keys as a line too
      this.detach();
      return arrowMenu(this.input, this.output, items, optional);
    }
    items.forEach((item, index) => console.log(`  ${index + 1}) ${item}`));
    for (;;) {
      const answer = (await this.ask('> '))?.trim();
      if (answer === undefined || (optional && !answer)) return undefined;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && items[index] !== undefined) return index;
    }
  }

  /** Pasted text up to a line with a single `.`; undefined on EOF before it or on an empty paste. */
  async readText(intro: string): Promise<string | undefined> {
    try {
      console.log(intro);
      const lines: string[] = [];
      for (;;) {
        const line = await this.ask('');
        if (line === undefined) return undefined;
        if (line.trim() === PASTE_END) break;
        lines.push(line);
      }
      const text = lines.join('\n').trim();
      return text ? `${text}\n` : undefined;
    } finally {
      this.release();
    }
  }

  private async askRound(rounds: number[]): Promise<number | undefined> {
    for (;;) {
      const answer = await this.ask(`Round (${rounds.join(', ')}): `);
      if (answer === undefined) return undefined;
      const round = Number(answer.trim());
      if (rounds.includes(round)) return round;
    }
  }

  /** Between gates stdin belongs to interactive harness sessions. */
  private release(): void {
    // a closed interface throws on pause/resume (Node ≥ 26)
    if (!this.closed) this.reader?.pause();
  }

  /** Lets go of the line reader without ending input; the next `ask` makes a new one. Lines already read stay queued. */
  private detach(): void {
    const reader = this.reader;
    if (!reader || this.closed) return;
    this.reader = undefined;
    reader.close();
  }

  close(): void {
    if (!this.closed) this.reader?.close();
  }

  private async ask(prompt: string): Promise<string | undefined> {
    this.ensure();
    if (!this.closed) this.reader!.resume();
    this.output.write(prompt);
    const answer = await this.nextLine();
    // a terminal echoed the answer with its newline; piped input leaves the prompt's line open for the next log line
    if (!this.input.isTTY) this.output.write('\n');
    return answer;
  }

  private nextLine(): Promise<string | undefined> {
    const next = this.lines.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  private ensure(): void {
    if (this.reader) return;
    const reader = createInterface({ input: this.input, terminal: false });
    this.reader = reader;
    reader.on('line', (line) => {
      if (this.waiting) {
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting(line);
      } else this.lines.push(line);
    });
    reader.on('close', () => {
      if (this.reader !== reader) return;
      this.closed = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
  }
}
