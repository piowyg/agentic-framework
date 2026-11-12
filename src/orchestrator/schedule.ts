import { errorMessage } from '../errors.js';
import type { Group } from './artifacts.js';
import type { GroupOutcome } from './group-runner.js';

/**
 * Runs groups at most `limit` at a time; a group starts once every group it depends on is done.
 * `settled` groups (finished in an earlier run) aren't run again. After an `aborted` outcome nothing new starts.
 * Groups waiting on a group that didn't finish get no outcome.
 */
export async function scheduleGroups(input: {
  groups: Group[];
  limit: number;
  settled: (group: Group) => GroupOutcome | undefined;
  runGroup: (group: Group) => Promise<GroupOutcome>;
}): Promise<Map<string, GroupOutcome>> {
  const outcomes = new Map<string, GroupOutcome>();
  for (const group of input.groups) {
    const outcome = input.settled(group);
    if (outcome) outcomes.set(group.id, outcome);
  }
  const running = new Map<string, Promise<void>>();
  let aborted = false;
  const isReady = (group: Group) =>
    !outcomes.has(group.id) && !running.has(group.id) && group.depends_on.every((dependency) => outcomes.get(dependency)?.status === 'done');
  for (;;) {
    for (const group of aborted ? [] : input.groups.filter(isReady)) {
      if (running.size >= input.limit) break;
      const finished = input
        .runGroup(group)
        .catch((error): GroupOutcome => ({ status: 'blocked', pause: { reason: 'error', group: group.id, message: errorMessage(error) } }))
        .then((outcome) => {
          outcomes.set(group.id, outcome);
          if (outcome.status === 'aborted') aborted = true;
          running.delete(group.id);
        });
      running.set(group.id, finished);
    }
    if (!running.size) return outcomes;
    await Promise.race(running.values());
  }
}
