import { describe, expectTypeOf, it } from 'vitest';
import type { AgenticConfig, ConfigLayer, Executor, StageConfig, StopTrigger } from '../src/config/types.js';

describe('config types derived from the schema', () => {
  it('executor fields are precise and required after merging', () => {
    expectTypeOf<Executor>().toEqualTypeOf<{ harness: 'claude' | 'codex'; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' }>();
  });

  it('a layer leaves every section optional', () => {
    expectTypeOf<{}>().toExtend<ConfigLayer>();
    expectTypeOf<{ review: { spec: null } }>().toExtend<ConfigLayer>();
    expectTypeOf<{ review: { spec: 'opus' } }>().not.toExtend<ConfigLayer>();
  });

  it('merged sections are filled, optional keys stay optional', () => {
    expectTypeOf<AgenticConfig['sandbox']['network']['allow']>().toEqualTypeOf<string[]>();
    expectTypeOf<AgenticConfig['review']['security']>().toEqualTypeOf<Executor | null>();
    expectTypeOf<AgenticConfig['review']['max_rounds']>().toEqualTypeOf<number>();
    expectTypeOf<StageConfig['stage_skill']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AgenticConfig['gates']>().toEqualTypeOf<Array<'ticket' | 'spec' | 'breakdown' | 'group' | 'merge' | 'final'> | undefined>();
  });

  it('stop triggers include the threshold forms', () => {
    expectTypeOf<{ rejection_rate: number }>().toExtend<StopTrigger>();
    expectTypeOf<'repeated_finding'>().toExtend<StopTrigger>();
    expectTypeOf<'whatever'>().not.toExtend<StopTrigger>();
  });
});
