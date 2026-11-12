import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuKey, splitKeys } from '../src/cli/arrow-menu.js';
import { TtyGates } from '../src/cli/tty-gates.js';

/** A terminal: keys go in raw, and what is drawn is kept. */
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(raw: boolean) {
    this.raw.push(raw);
    return this;
  } });
  const output = Object.assign(new PassThrough(), { isTTY: true, drawn: '' }) as unknown as NodeJS.WriteStream & { drawn: string };
  output.write = ((chunk: string) => ((output.drawn += chunk), true)) as never;
  return { input, output };
}

/** Keys one chunk at a time, after the menu is listening. */
async function type(input: PassThrough, ...chunks: string[]) {
  for (const chunk of chunks) {
    await new Promise((resolve) => setImmediate(resolve));
    input.write(chunk);
  }
}

describe('arrow menu', () => {
  afterEach(() => vi.restoreAllMocks());

  it('arrows move and wrap, digits pick by number, Enter chooses', () => {
    const start = { index: 0, digits: '' };
    expect(menuKey(start, '\x1b[A', 3)).toEqual({ state: { index: 2, digits: '' } });
    expect(menuKey(start, '\x1b[B', 3)).toEqual({ state: { index: 1, digits: '' } });
    expect(menuKey({ index: 0, digits: '1' }, '2', 12)).toEqual({ state: { index: 11, digits: '12' } });
    expect(menuKey({ index: 0, digits: '1' }, '3', 12)).toEqual({ state: { index: 2, digits: '3' } });
    expect(menuKey({ index: 2, digits: '' }, '\r', 3)).toEqual({ chosen: 2 });
  });

  it('Esc chooses nothing only where nothing is a choice; Ctrl-D always', () => {
    const start = { index: 1, digits: '' };
    expect(menuKey(start, '\x1b', 3, true)).toEqual({ none: true });
    expect(menuKey(start, '\x1b', 3)).toEqual({ state: start });
    expect(menuKey(start, '\x04', 3)).toEqual({ none: true });
  });

  it('a chunk of keys keeps escape sequences whole', () => {
    expect(splitKeys('\x1b[B\x1b[Bx\r')).toEqual(['\x1b[B', '\x1b[B', 'x', '\r']);
  });

  it('a gate takes arrows in raw mode, ignores Esc, and gives the terminal back for the next question', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { input, output } = terminal();
    const gates = new TtyGates(input, output);
    const decision = gates.decide({ slug: 'f', workDir: '/tmp', gate: 'spec', summary: 's', actions: ['continue', 'stop', 'abort'] });
    await type(input, '\x1b', '\x1b[B\x1b[B', '\x1b[A', '\r');
    expect(await decision).toEqual({ action: 'stop' });
    expect(input.raw).toEqual([true, false]);
    expect(output.drawn).toMatch(/❯ 2\) save and pause/);

    const answer = gates.confirm('Dalej?');
    await type(input, 'y\n');
    expect(await answer).toBe(true);
    gates.close();
  });

  it('a list: Esc is none, and without a terminal it is numbered', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { input, output } = terminal();
    const none = new TtyGates(input, output).choose('Który?', ['a', 'b']);
    await type(input, '\x1b');
    expect(await none).toBeUndefined();

    const piped = Object.assign(new PassThrough(), { isTTY: false });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const numbered = new TtyGates(piped).choose('Który?', ['a', 'b']);
    piped.end('2\n');
    expect(await numbered).toBe(1);
  });

  it('a piped answer ends its line: nothing echoed it, the next log line starts on its own', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { output } = terminal();
    const piped = Object.assign(new PassThrough(), { isTTY: false });
    const decision = new TtyGates(piped, output).decide({ slug: 'f', workDir: '/tmp', gate: 'spec', summary: 's', actions: ['continue', 'retry'] });
    piped.end('2\nshorter\n');
    expect(await decision).toEqual({ action: 'retry', note: 'shorter' });
    expect(output.drawn).toMatch(/Note: \n$/);
  });
});
