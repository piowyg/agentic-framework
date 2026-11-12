import { describe, expect, it } from 'vitest';
import { LiveLine } from '../src/cli/live-line.js';

/** A terminal that keeps what was written; `\r\x1b[2K` clears the line being written. */
function terminal(isTTY = true) {
  const writes: string[] = [];
  const output = { isTTY, columns: 60, write: (text: string) => writes.push(text) } as unknown as NodeJS.WriteStream;
  const screen = () =>
    writes
      .join('')
      .split('\n')
      .map((line) => line.split('\r\x1b[2K').at(-1)!);
  return { output, screen };
}

describe('LiveLine', () => {
  it('shows what runs now with its time so far; finished, the log line takes its place', () => {
    let now = 0;
    const { output, screen } = terminal();
    const live = new LiveLine(output, () => now);
    live.progress('g1-t1', '  ▸ g1/t1 1/2: npm test');
    expect(screen()).toEqual(['  ▸ g1/t1 1/2: npm test (0 s)']);
    now = 12_000;
    live.say('! g2: something else');
    // logged lines go above the live one
    expect(screen()).toEqual(['! g2: something else', '  ▸ g1/t1 1/2: npm test (12 s)']);
    live.progress('g1-t1');
    live.say('  ✓ g1/t1 1/2: npm test (12 s)');
    expect(screen()).toEqual(['! g2: something else', '  ✓ g1/t1 1/2: npm test (12 s)', '']);
  });

  it('a gate\'s menu has the terminal to itself', async () => {
    const { output, screen } = terminal();
    const live = new LiveLine(output, () => 0);
    live.progress('g1-t1', '  ▸ g1/t1 1/2: npm test');
    await live.aside(async () => {
      output.write('menu\n');
      live.progress('g2-t1', '  ▸ g2/t1 1/1: make');
      expect(screen()).toEqual(['menu', '']);
    });
    expect(screen()).toEqual(['menu', '  ▸ g2/t1 1/1: make (0 s)']);
    live.progress('g1-t1');
    live.progress('g2-t1');
  });

  it('what another group logs while a gate asks follows the answer, on a terminal or not', async () => {
    for (const isTTY of [true, false]) {
      const { output, screen } = terminal(isTTY);
      const live = new LiveLine(output, () => 0);
      await live.aside(async () => {
        output.write('Notatka: ');
        live.say('Klon grupy g1 usunięty');
        output.write('fix it\n');
      });
      expect(screen()).toEqual(['Notatka: fix it', 'Klon grupy g1 usunięty', '']);
    }
  });

  it('a line wider than the terminal is cut, so it can be cleared', () => {
    const { output, screen } = terminal();
    const live = new LiveLine(output, () => 0);
    live.progress('g1-t1', `  ▸ g1/t1 1/1: ${'x'.repeat(100)}`);
    expect(screen()[0]).toHaveLength(59);
    expect(screen()[0]!.endsWith('…')).toBe(true);
    live.progress('g1-t1');
  });

  it('off a terminal there is no live line', () => {
    const { output, screen } = terminal(false);
    const live = new LiveLine(output, () => 0);
    live.progress('g1-t1', '  ▸ g1/t1 1/2: npm test');
    live.say('  ✓ g1/t1 1/2: npm test (3 s)');
    expect(screen()).toEqual(['  ✓ g1/t1 1/2: npm test (3 s)', '']);
  });
});
