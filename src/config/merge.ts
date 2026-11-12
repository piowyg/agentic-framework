const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Objects merge recursively; arrays and scalars are replaced. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
