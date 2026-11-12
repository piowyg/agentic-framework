import type { Budget, GateName } from '../config/types.js';
import type { GateKeeper } from './gatekeeper.js';
import { Halt, type FlowRun } from './run.js';
import type { StageId } from './state.js';
import { recordUsd } from './usage-report.js';
import { readUsage } from './usage.js';

/** A human's `continue` past the budget raises every limit by this factor. */
export const BUDGET_RAISE = 1.5;

export interface BudgetUse {
  /** Time of the sessions without a human, not the waits at gates nor the grills, which go at the human's pace. */
  minutes: number;
  /** Input and output. */
  tokens: number;
  /** Harness-reported, else priced from the profile; a lower bound when some sessions have neither. */
  usd: number;
}

export function budgetUse(flow: FlowRun): BudgetUse {
  const use: BudgetUse = { minutes: 0, tokens: 0, usd: 0 };
  for (const record of readUsage(flow.context.workDir)) {
    if (!record.kind.startsWith('grill-')) use.minutes += record.duration_ms / 60_000;
    use.tokens += record.input_tokens + record.output_tokens;
    use.usd += recordUsd(record, flow.context.profile.pricing).usd ?? 0;
  }
  return use;
}

/** The configured limits, raised by every `continue` past them so far. */
export function budgetLimits(budget: Budget, raises = 0): Budget {
  const factor = BUDGET_RAISE ** raises;
  return Object.fromEntries(Object.entries(budget).filter(([, limit]) => limit !== undefined).map(([key, limit]) => [key, limit! * factor])) as Budget;
}

const UNITS: Record<keyof Budget, (value: number) => string> = {
  minutes: (value) => `${Number.isInteger(value) ? value : value.toFixed(1)} min`,
  tokens: (value) => `${(value / 1e6).toFixed(2)}M tokens`,
  usd: (value) => `$${value.toFixed(2)}`,
};

/** Each limit the flow went past, as `62 min z 60 min`. */
export function overBudget(limits: Budget, use: BudgetUse): string[] {
  return (Object.keys(UNITS) as Array<keyof Budget>).flatMap((key) => {
    const limit = limits[key];
    return limit !== undefined && use[key] >= limit ? [`${UNITS[key](use[key])} of ${UNITS[key](limit)}`] : [];
  });
}

/** The gate a budget question shows as: the group's, else the stage's own. */
const STAGE_GATES: Record<StageId, GateName> = { ticket: 'ticket', spec: 'spec', breakdown: 'breakdown', implement: 'group', 'final-review': 'final' };

/**
 * The flow's budget, checked from `usage.jsonl` before every session — parallel groups ask one at a
 * time. Past it a human decides: `continue` raises every limit by half, `stop` pauses until `agentic resume` asks again.
 */
export class BudgetGuard {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly flow: FlowRun,
    private readonly gatekeeper: GateKeeper,
  ) {}

  check(group?: string): Promise<void> {
    const next = this.queue.then(() => this.ask(group));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ask(group?: string): Promise<void> {
    const { flow } = this;
    const limits = budgetLimits(flow.context.config.budget, flow.state.budget_raises);
    const over = overBudget(limits, budgetUse(flow));
    if (!over.length) return;
    const next = budgetLimits(flow.context.config.budget, (flow.state.budget_raises ?? 0) + 1);
    const nextText = (Object.keys(UNITS) as Array<keyof Budget>).flatMap((key) => (next[key] === undefined ? [] : [UNITS[key](next[key]!)])).join(', ');
    const message = `flow budget exceeded: ${over.join(', ')}`;
    try {
      await this.gatekeeper.ask(
        group ? 'group' : STAGE_GATES[flow.state.stage],
        `${message}.\ncontinue = limits +50% (${nextText}); pause = \`agentic resume\` asks again (or raise \`budget\` in the global config).`,
        ['continue', 'stop', 'abort'],
        { group },
      );
    } catch (error) {
      if (error instanceof Halt && error.status === 'paused') throw new Halt('paused', { reason: 'budget', group, message });
      throw error;
    }
    flow.state.budget_raises = (flow.state.budget_raises ?? 0) + 1;
    flow.save();
    flow.log(`! budget raised by 50% (${nextText})`);
  }
}
