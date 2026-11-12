import { spawn } from 'node:child_process';
import type { AgenticConfig } from '../config/types.js';
import type { FlowEventRecord } from './events.js';

/** How long a notification command may run before it is killed: it must never hold anything up. */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** Pauses a human chose themselves (a gate's or a decision's `stop`): they are at the terminal already. */
const HUMAN_PAUSES = new Set(['gate', 'human']);

export interface NotifyOutput {
  /** The terminal bell, when there is no command. */
  bell(): void;
  run(command: string, env: Record<string, string>): void;
}

/**
 * Notifications: an event named in `notify.on` rings the terminal bell, or runs `notify.command` instead
 * (global config only) with the event in `AGENTIC_*` variables — in the background, its failure never stops the flow.
 */
export function notifier(notify: AgenticConfig['notify'], output: NotifyOutput = HOST_OUTPUT): (record: FlowEventRecord) => void {
  const wanted = new Set<string>(notify.on);
  // a flow that pauses on a group already announced rings once
  const announced = new Set<string>();
  return (record) => {
    if ((record.type === 'flow_paused' || record.type === 'flow_failed') && announced.has(`${record.group}:${record.reason}`)) return;
    if (!wanted.has(record.type)) return;
    if ((record.type === 'flow_paused' || record.type === 'group_blocked') && HUMAN_PAUSES.has(record.reason)) return;
    if (record.type === 'group_blocked') announced.add(`${record.group}:${record.reason}`);
    if (!notify.command) return output.bell();
    output.run(notify.command, notificationEnv(record));
  };
}

/** What happened, for the command: the event type, the flow, its group and a one-line message. */
export function notificationEnv(record: FlowEventRecord): Record<string, string> {
  const group = 'group' in record && record.group ? record.group : undefined;
  const message =
    record.type === 'human_needed' ? record.summary : 'message' in record && record.message ? record.message : record.type === 'flow_done' ? record.outcome : '';
  return {
    AGENTIC_EVENT: record.type,
    AGENTIC_SLUG: record.slug,
    ...(group && { AGENTIC_GROUP: group }),
    AGENTIC_MESSAGE: String(message).split('\n')[0]!.slice(0, 200),
  };
}

const HOST_OUTPUT: NotifyOutput = {
  bell() {
    if (process.stderr.isTTY) process.stderr.write('\x07');
  },
  run(command, env) {
    try {
      const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // a notification is never worth failing the flow over
    }
  },
};
