import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { configSchema } from './schema.js';

export class ConfigError extends Error {
  constructor(
    readonly source: string,
    readonly problems: string[],
  ) {
    super(`Invalid config (${source}):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  compiled ??= new Ajv({ allErrors: true, strict: true }).compile(configSchema);
  return compiled;
}

export function validateLayer(layer: unknown, source: string): void {
  const validate = validator();
  if (validate(layer)) return;
  throw new ConfigError(source, formatErrors(validate.errors ?? []));
}

/** `schema` is the validated root, used to suggest a known field for a typo. */
export function formatErrors(errors: ErrorObject[], schema: object = configSchema): string[] {
  // anyOf reports every failing branch; show a single message per path
  const unionPaths = new Set(errors.filter((error) => error.keyword === 'anyOf').map((error) => error.instancePath));
  const out = new Set<string>();
  for (const error of errors) {
    const path = toPath(error.instancePath);
    if (error.keyword !== 'anyOf' && [...unionPaths].some((unionPath) => error.instancePath === unionPath || error.instancePath.startsWith(`${unionPath}/`))) continue;
    out.add(describe(error, path, schema));
  }
  return [...out];
}

function describe(error: ErrorObject, path: string, schema: object): string {
  switch (error.keyword) {
    case 'additionalProperties': {
      const key = (error.params as { additionalProperty: string }).additionalProperty;
      const known = Object.keys(propertiesAt(schema, error.schemaPath));
      const hint = closest(key, known);
      return `${join(path, key)}: unknown field${hint ? ` (did you mean \`${hint}\`?)` : ''}`;
    }
    case 'enum': {
      const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
      return `${path}: allowed values: ${allowed.map((value) => `\`${String(value)}\``).join(', ')}`;
    }
    case 'type':
      return `${path}: expected type ${(error.params as { type: string }).type}`;
    case 'required':
      return `${path}: missing required field \`${(error.params as { missingProperty: string }).missingProperty}\``;
    case 'anyOf':
      return `${path}: invalid value (see the allowed forms in docs/reference/config.md)`;
    default:
      return `${path}: ${error.message ?? error.keyword}`;
  }
}

function toPath(instancePath: string): string {
  if (!instancePath) return '(root)';
  return instancePath
    .slice(1)
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}

function join(path: string, key: string): string {
  return path === '(root)' ? key : `${path}.${key}`;
}

function propertiesAt(schema: object, schemaPath: string): Record<string, unknown> {
  // e.g. "#/properties/review/additionalProperties" → the review node
  const parts = schemaPath.replace(/^#\//, '').split('/').slice(0, -1);
  let node: unknown = schema;
  for (const part of parts) node = (node as Record<string, unknown> | undefined)?.[decodeURIComponent(part)];
  return ((node as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>;
}

function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(word, candidate);
    if (distance < bestDist) [best, bestDist] = [candidate, distance];
  }
  return bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function levenshtein(source: string, target: string): number {
  const previousRow = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex++) {
    let diagonal = previousRow[0]!;
    previousRow[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex++) {
      const above = previousRow[targetIndex]!;
      previousRow[targetIndex] = Math.min(previousRow[targetIndex]! + 1, previousRow[targetIndex - 1]! + 1, diagonal + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previousRow[target.length]!;
}
