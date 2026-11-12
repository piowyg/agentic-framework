import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyTicket, pastedTitle } from '../src/cli/paste.js';
import { TtyGates } from '../src/cli/tty-gates.js';
import { FAKE_TICKET } from '../src/harness/fake.js';

describe('pasted text', () => {
  afterEach(() => vi.restoreAllMocks());

  const quiet = () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  it('is read up to a `.` line, and the same terminal still answers the next question', async () => {
    quiet();
    const gates = new TtyGates(Readable.from(['# Title\n', '\n', 'body\n', '.\n', 'y\n']));
    expect(await gates.readText('Paste')).toBe('# Title\n\nbody\n');
    expect(await gates.confirm('Start?')).toBe(true);
    gates.close();
  });

  it('a list answers with the index chosen; a wrong number asks again, Enter chooses nothing', async () => {
    quiet();
    expect(await new TtyGates(Readable.from(['7\n', '2\n'])).choose('Which?', ['a', 'b'])).toBe(1);
    expect(await new TtyGates(Readable.from(['\n'])).choose('Which?', ['a', 'b'])).toBeUndefined();
  });

  it('is lost on EOF before the `.` line, and an empty paste is nothing', async () => {
    quiet();
    expect(await new TtyGates(Readable.from(['body\n'])).readText('Paste')).toBeUndefined();
    expect(await new TtyGates(Readable.from(['  \n', '.\n'])).readText('Paste')).toBeUndefined();
  });

  it('titles the flow with its first line, without frontmatter or markdown markers', () => {
    expect(pastedTitle('\n## Guests save the cart\nmore')).toBe('Guests save the cart');
    expect(pastedTitle('---\nstatus: [broken\n---\n- Export to CSV\n')).toBe('Export to CSV');
    expect(pastedTitle('x'.repeat(200))).toHaveLength(80);
  });

  it('a ticket within the contract goes to the technical grill; anything else is an idea, with the reasons', () => {
    expect(classifyTicket(FAKE_TICKET)).toMatchObject({ kind: 'ticket' });
    const jira = 'SHOP-12 Export to CSV\nAs a user I want to export the list.\n';
    expect(classifyTicket(jira)).toEqual({
      kind: 'idea',
      title: 'SHOP-12 Export to CSV',
      problems: ['frontmatter: no `status: ready`', 'no acceptance criteria with IDs (`AC-1`, `AC-2`, …)'],
    });
    expect(classifyTicket('---\nstatus: [broken\n---\nAC-1')).toMatchObject({ kind: 'idea' });
  });

  it('a ticket without tracker_key or title is named by `untitled`; an idea keeps its first line', () => {
    const untitled = '---\nstatus: ready\n---\n# Export\n- AC-1: exports\n';
    expect(classifyTicket(untitled, 'shop-12')).toEqual({ kind: 'ticket', title: 'shop-12' });
    expect(classifyTicket(untitled)).toEqual({ kind: 'ticket', title: 'Export' });
    expect(classifyTicket('# #10 Admin panel\n- [ ] sections', 'tmp')).toMatchObject({ kind: 'idea', title: '#10 Admin panel' });
  });
});
