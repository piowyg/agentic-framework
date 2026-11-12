/** A terminal whose keys come one by one, unechoed: `process.stdin` when it is a TTY. */
export type RawInput = NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };

export interface MenuState {
  /** The highlighted item. */
  index: number;
  /** Digits typed so far: a number picks an item, as in the numbered list. */
  digits: string;
}

/** What a key does: move the highlight, choose, or leave with nothing (`none`), or `interrupt` (Ctrl-C). */
export type MenuStep = { state: MenuState } | { chosen: number } | { none: true } | { interrupt: true };

const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j', '\t'];

/** Ctrl-D is EOF: nothing chosen, at a gate that is stop. Esc and q choose nothing only from an `optional` menu. */
export function menuKey(state: MenuState, key: string, count: number, optional = false): MenuStep {
  if (key === '\x03') return { interrupt: true };
  if (key === '\r' || key === '\n') return { chosen: state.index };
  if (key === '\x04' || (optional && (key === '\x1b' || key === 'q'))) return { none: true };
  if (UP.includes(key)) return { state: { index: (state.index - 1 + count) % count, digits: '' } };
  if (DOWN.includes(key)) return { state: { index: (state.index + 1) % count, digits: '' } };
  if (/^[0-9]$/.test(key)) {
    const digits = Number(state.digits + key) <= count ? state.digits + key : key;
    const number = Number(digits);
    return { state: { index: number >= 1 && number <= count ? number - 1 : state.index, digits } };
  }
  return { state };
}

/** A pasted or fast-typed sequence arrives as one chunk: escape sequences stay whole, everything else is one key per character. */
export function splitKeys(chunk: string): string[] {
  return chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g) ?? [];
}

export function renderMenu(items: string[], index: number): string[] {
  return items.map((item, at) => (at === index ? `\x1b[1m❯ ${at + 1}) ${item}\x1b[22m` : `  ${at + 1}) ${item}`));
}

/**
 * Arrow keys over `items`, redrawn in place; digits still pick by number. The terminal leaves raw mode before
 * the promise settles, and on process exit: an interactive harness session takes it over next.
 */
export function arrowMenu(input: RawInput, output: NodeJS.WriteStream, items: string[], optional = false): Promise<number | undefined> {
  return new Promise((resolve) => {
    let state: MenuState = { index: 0, digits: '' };
    const draw = (first: boolean) => {
      const lines = renderMenu(items, state.index);
      output.write(`${first ? '' : `\x1b[${lines.length}A`}${lines.map((line) => `\r\x1b[2K${line}`).join('\n')}\n`);
    };
    const restore = () => {
      input.setRawMode?.(false);
      output.write('\x1b[?25h');
    };
    const finish = (result: number | undefined) => {
      input.removeListener('data', onData);
      process.removeListener('exit', restore);
      restore();
      input.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      for (const key of splitKeys(chunk.toString())) {
        const step = menuKey(state, key, items.length, optional);
        if ('state' in step) {
          state = step.state;
          continue;
        }
        if ('interrupt' in step) {
          finish(undefined);
          process.kill(process.pid, 'SIGINT');
          return;
        }
        draw(false);
        return finish('chosen' in step ? step.chosen : undefined);
      }
      draw(false);
    };
    process.on('exit', restore);
    input.setRawMode?.(true);
    output.write('\x1b[?25l');
    draw(true);
    input.on('data', onData);
    input.resume();
  });
}
