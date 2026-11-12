import { REVIEW_AXES } from './schema.js';
import type { Executor, ReviewAxes, ReviewAxis } from './types.js';

/** Axes switched on in config, in `REVIEW_AXES` order. */
export function enabledAxes(review: ReviewAxes): [ReviewAxis, Executor][] {
  return REVIEW_AXES.flatMap((axis) => {
    const executor = review[axis];
    return executor ? [[axis, executor] as [ReviewAxis, Executor]] : [];
  });
}
