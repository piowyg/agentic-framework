import type { AgenticConfig, Autonomy, GateName } from './types.js';
import { GATES } from './schema.js';

const PRESETS: Record<Exclude<Autonomy, 'custom'>, GateName[]> = {
  strict: [...GATES],
  standard: ['ticket', 'spec', 'breakdown', 'merge', 'final'],
  autopilot: ['breakdown', 'final'],
};

export function activeGates(config: Pick<AgenticConfig, 'autonomy' | 'gates'>): Set<GateName> {
  if (config.autonomy === 'custom') return new Set(config.gates ?? []);
  return new Set(PRESETS[config.autonomy]);
}
