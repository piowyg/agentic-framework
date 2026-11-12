import { activeGates } from '../config/gates.js';
import type { GateName } from '../config/types.js';
import { gateActions, withRollback, type GateDecision, type GateSummary, type GateView } from './gates.js';
import { Halt, type FlowRun } from './run.js';

/** Who is asking: a group (absent for the whole flow) and the rounds its review loop can roll back to. */
export interface GateScope {
  group?: string;
  rollbackRounds?: number[];
  /** Why the gate asks even when the preset skips it (e.g. a one-way change before `final`). */
  forced?: string;
}

/** Human decisions: preset gates and the `on_stop` chain, each announced as `human_needed` / `gate_decided`. */
export class GateKeeper {
  private readonly active: Set<GateName>;

  constructor(private readonly flow: FlowRun) {
    this.active = activeGates(flow.context.config);
  }

  /** An inactive gate passes without asking unless `forced`; `summary` is built only when someone will read it. */
  async gate(gate: GateName, summary: () => GateSummary, scope: GateScope = {}): Promise<GateDecision> {
    const { group, forced } = scope;
    const active = this.active.has(gate);
    if (!active && !forced) return { action: 'continue' };
    const { text, view } = summary();
    // the reason once: the summary may give it already (the final gate's one-way note)
    const header = `gate ${gate} outside the preset${forced && text.includes(forced) ? '' : `: ${forced}`}`;
    const decision = await this.decide(gate, active ? text : `${header}\n${text}`, gateActions(gate), scope, view);
    switch (decision.action) {
      case 'continue':
      case 'retry':
      case 'rollback':
      case 'manual':
        return decision;
      case 'stop':
        throw new Halt('paused', { reason: 'gate', gate, group, message: `paused at gate ${gate}` });
      case 'push_and_stop':
        // TODO: push the ticket through the tracker adapter
        this.flow.log('Tracker: pushing the ticket is not supported yet; the ticket is saved locally.');
        throw new Halt('done', undefined, 'ticket_only');
      case 'abort':
        throw new Halt('aborted', { reason: 'gate', gate, group, message: 'aborted' });
    }
  }

  /**
   * `on_stop` chain: `escalate` hands the next fix round to a stronger model when the caller `canEscalate` (else the
   * next action), `human` asks regardless of the gate preset, `fail` fails the group (the flow outside a group).
   * An exhausted chain asks the human instead of pausing without a decision.
   */
  async onStop(
    gate: GateName,
    message: string,
    actions: GateDecision['action'][],
    scope: GateScope & { canEscalate?: boolean } = {},
  ): Promise<GateDecision | { action: 'escalate' }> {
    for (const action of this.flow.context.config.review.on_stop) {
      if (action === 'escalate') {
        if (scope.canEscalate) return { action: 'escalate' };
        continue;
      }
      if (action === 'fail') throw new Halt('failed', { reason: 'review_failed', gate, group: scope.group, message });
      return this.askHuman(gate, message, actions, scope);
    }
    return this.askHuman(gate, message, actions, scope);
  }

  /** A decision only a human can make, whatever the preset (e.g. checks red on the base). */
  ask(gate: GateName, message: string, actions: GateDecision['action'][], scope: GateScope = {}): Promise<GateDecision> {
    return this.askHuman(gate, message, actions, scope);
  }

  private async askHuman(gate: GateName, message: string, actions: GateDecision['action'][], scope: GateScope): Promise<GateDecision> {
    const { group } = scope;
    const decision = await this.decide(gate, message, actions, scope);
    if (decision.action === 'stop') throw new Halt('paused', { reason: 'human', gate, group, message });
    if (decision.action === 'abort') throw new Halt('aborted', { reason: 'human', gate, group, message: 'aborted' });
    return decision;
  }

  private async decide(gate: GateName, summary: string, baseActions: GateDecision['action'][], scope: GateScope, view?: GateView): Promise<GateDecision> {
    const { group, rollbackRounds = [] } = scope;
    // a group reaching a gate after another group aborted the flow doesn't ask
    this.flow.checkNotStopped(group);
    this.flow.emit({ type: 'human_needed', gate, group, summary });
    const { context, state } = this.flow;
    const actions = withRollback(baseActions, rollbackRounds);
    const decision = await context.gates.decide({
      gate,
      group,
      slug: state.slug,
      workDir: context.workDir,
      summary,
      ...(view && { view }),
      actions,
      ...(actions.includes('rollback') && { rounds: rollbackRounds }),
    });
    if (decision.action === 'rollback' && !rollbackRounds.includes(decision.round)) {
      throw new Error(`gate ${gate}: can't roll back to round ${decision.round} (available: ${rollbackRounds.join(', ')})`);
    }
    this.flow.emit({ type: 'gate_decided', gate, group, action: decision.action });
    return decision;
  }
}
