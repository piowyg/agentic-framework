import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry } from '../src/harness/fake.js';
import type { FlowEventRecord } from '../src/orchestrator/events.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { notifier, type NotifyOutput } from '../src/orchestrator/notify.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

// Notifications.

function recording() {
  const rang: string[] = [];
  const ran: Array<Record<string, string>> = [];
  const output: NotifyOutput = { bell: () => rang.push('bell'), run: (_command, env) => ran.push(env) };
  return { rang, ran, output };
}

const event = (record: object) => ({ at: '', slug: 'koszyk', ...record }) as FlowEventRecord;

describe('notifier', () => {
  it('rings the bell for the events in notify.on, nothing for the rest', () => {
    const { rang, output } = recording();
    const notify = notifier({ on: ['human_needed', 'flow_done'] }, output);
    notify(event({ type: 'human_needed', gate: 'spec', summary: 'spec gotowy' }));
    notify(event({ type: 'session_started', kind: 'implement' }));
    notify(event({ type: 'group_done', group: 'g1' }));
    notify(event({ type: 'flow_done', outcome: 'ready_to_publish' }));
    expect(rang).toEqual(['bell', 'bell']);
  });

  it('a command replaces the bell and gets the event in AGENTIC_* variables', () => {
    const { rang, ran, output } = recording();
    const notify = notifier({ on: ['human_needed'], command: 'say hej' }, output);
    notify(event({ type: 'human_needed', gate: 'group', group: 'g1', summary: 'grupa g1: 2 uwagi blocking\nszczegóły' }));
    expect(rang).toEqual([]);
    expect(ran).toEqual([{ AGENTIC_EVENT: 'human_needed', AGENTIC_SLUG: 'koszyk', AGENTIC_GROUP: 'g1', AGENTIC_MESSAGE: 'grupa g1: 2 uwagi blocking' }]);
  });

  it('a pause the human chose rings nothing; a flow paused on an announced group rings once', () => {
    const { rang, output } = recording();
    const notify = notifier({ on: ['group_blocked', 'flow_paused'] }, output);
    notify(event({ type: 'flow_paused', reason: 'gate', message: 'wstrzymano na bramce spec' }));
    notify(event({ type: 'group_blocked', group: 'g1', reason: 'human' }));
    expect(rang).toEqual([]);
    notify(event({ type: 'group_blocked', group: 'g1', reason: 'timeout' }));
    notify(event({ type: 'flow_paused', group: 'g1', reason: 'timeout' }));
    notify(event({ type: 'flow_paused', group: 'g2', reason: 'error' }));
    expect(rang).toEqual(['bell', 'bell']);
  });

  it('runs the command in the background through sh', async () => {
    const file = path.join(tmpDir(), 'notified');
    notifier({ on: ['flow_done'], command: `printf '%s %s %s' "$AGENTIC_EVENT" "$AGENTIC_SLUG" "$AGENTIC_MESSAGE" > '${file}'` })(
      event({ type: 'flow_done', outcome: 'ready_to_publish' }),
    );
    await vi.waitFor(() => expect(fs.readFileSync(file, 'utf8')).toBe('flow_done koszyk ready_to_publish'), { timeout: 5000 });
  });
});

describe('group_blocked', () => {
  it('is emitted when a group stops for resume, so the human hears of it while other groups go on', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry({ implement: { exitCode: 143, timedOut: true } });
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    const { rang, output } = recording();
    const delivered: FlowEventRecord[] = [];
    const notify = notifier({ on: ['group_blocked', 'flow_paused'] }, output);
    await runFlow({
      workDir,
      config: TEST_CONFIG,
      catalog: loadCatalog(),
      profile: NO_PROFILE,
      harnesses,
      sandbox: harnesses.sandbox,
      gates: new ScriptedGates(),
      onEvent: (record) => {
        delivered.push(record);
        notify(record);
      },
    });
    expect(delivered.filter((record) => record.type === 'group_blocked' || record.type === 'flow_paused')).toMatchObject([
      { type: 'group_blocked', group: 'g1', reason: 'timeout', message: expect.stringMatching(/session_timeout/) },
      { type: 'flow_paused', group: 'g1', reason: 'timeout' },
    ]);
    // once for the blocked group, not again for the flow paused on it
    expect(rang).toHaveLength(1);
  });
});
