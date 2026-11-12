import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import { DEFAULTS } from './defaults.js';
import { gitInfo } from './git.js';
import { deepMerge } from './merge.js';
import { checkConfigModels, fillHarness, loadCatalog, type ModelCatalog } from './models.js';
import { expandHome, resolveProfile } from './profile.js';
import { enabledAxes } from './review-axes.js';
import { GATES, REVIEW_AXES } from './schema.js';
import type { AgenticConfig, ConfigLayer, Profile, StopTrigger } from './types.js';
import { activeGates } from './gates.js';
import { ConfigError, validateLayer } from './validate.js';

export type LayerName = 'defaults' | 'global' | 'profile' | 'workspace' | 'repo' | 'flow';

export interface LayerInfo {
  name: LayerName;
  file?: string;
  present: boolean;
}

export interface ResolvedProfile extends Omit<Profile, 'match' | 'budget' | 'tiers'> {
  name?: string;
  reason: 'remote' | 'path' | 'default' | 'none';
}

/** No profile matched and no `default_profile`: no pricing, pause on rate limit. */
export const NO_PROFILE: ResolvedProfile = { reason: 'none' };

export interface LoadedConfig {
  config: AgenticConfig;
  profile: ResolvedProfile;
  catalog: ModelCatalog;
  layers: LayerInfo[];
  globalDir: string;
  workspaceRoot?: string;
  repoRoot?: string;
  remote?: string;
  /** Values from workspace/repo layers that were raised back to the stricter one. */
  warnings: string[];
  /** The layer whose `skills.disabled` / `rules.disabled` won (arrays replace, so the last layer that set one). */
  disabledIn: { skills?: string; rules?: string };
}

export interface LoadOptions {
  cwd: string;
  flow?: ConfigLayer;
  env?: NodeJS.ProcessEnv;
  catalog?: ModelCatalog;
}

/** The repo the command works in: the git root, else the directory it was run from. */
export function repoRootOf(loaded: Pick<LoadedConfig, 'repoRoot'>, cwd = process.cwd()): string {
  return path.resolve(loaded.repoRoot ?? cwd);
}

export function globalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTIC_HOME ?? path.join(os.homedir(), '.agentic');
}

/**
 * Nearest ancestor with repos.yaml and .agentic/config.yaml owned by the current user
 * (like git's safe.directory — e.g. a planted /tmp/.agentic).
 * Inside a git repo the search starts above it, so a repo can't pose as the workspace and hide the real one.
 */
export function findWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env, gitRoot?: string): string | undefined {
  if (env.AGENTIC_WORKSPACE) return path.resolve(env.AGENTIC_WORKSPACE);
  return (gitRoot && searchWorkspace(path.dirname(gitRoot))) || searchWorkspace(cwd);
}

function searchWorkspace(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const config = path.join(dir, '.agentic', 'config.yaml');
    if (fs.existsSync(path.join(dir, 'repos.yaml')) && fs.existsSync(config) && ownedByMe(dir) && ownedByMe(config)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function ownedByMe(file: string): boolean {
  const uid = process.getuid?.();
  return uid === undefined || fs.statSync(file).uid === uid;
}

/** Merge order: defaults → global → profile → workspace → repo → flow. */
export function loadConfig(options: LoadOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const gDir = globalDir(env);
  const git = gitInfo(options.cwd);
  const workspaceRoot = findWorkspaceRoot(options.cwd, env, git.root);
  const repoRoot = git.root && git.root !== workspaceRoot ? git.root : undefined;

  const globalFile = path.join(gDir, 'config.yaml');
  const workspaceFile = workspaceRoot ? path.join(workspaceRoot, '.agentic', 'config.yaml') : undefined;
  const repoFile = repoRoot ? path.join(repoRoot, '.agentic', 'config.yaml') : undefined;

  const global = readLayer(globalFile);
  const workspace = workspaceFile ? readLayer(workspaceFile) : undefined;
  const repo = repoFile ? readLayer(repoFile) : undefined;
  if (options.flow) validateLayer(options.flow, 'flow');
  // a workspace found inside the current repo is repo content unless the user registered it
  const workspaceTrusted =
    !!workspaceRoot && (!!env.AGENTIC_WORKSPACE || !isWithin(workspaceRoot, git.root) || registered(workspaceRoot, global?.workspaces as string[] | undefined));
  for (const [layer, file] of [[workspace, workspaceFile], [repo, repoFile], [options.flow, 'flow']] as const) {
    if (layer && file) checkGlobalOnly(layer, file, layer === repo || (layer === workspace && !workspaceTrusted) ? REPO_FORBIDDEN : []);
  }

  // profiles come from the global config only (see GLOBAL_ONLY)
  const declared = deepMerge<Record<string, Profile>>({}, global?.profiles ?? {});
  const defaultProfile = global?.default_profile as string | undefined;
  const match = resolveProfile(declared, defaultProfile, { remote: git.remote, path: repoRoot ?? options.cwd });
  const { budget, tiers, match: _match, ...profileRest } = match.profile;
  const profileLayer: ConfigLayer = { ...(budget && { budget }), ...(tiers && { tiers }) };

  const catalog = options.catalog ?? loadCatalog();
  let merged: AgenticConfig = DEFAULTS;
  const warnings: string[] = [];
  const disabledIn: LoadedConfig['disabledIn'] = {};
  for (const [layer, file, name] of [[global, globalFile, 'global'], [profileLayer, undefined, 'profile'], [workspace, workspaceFile, 'workspace'], [repo, repoFile, 'repo'], [options.flow, undefined, 'flow']] as const) {
    if (!layer) continue;
    if (layer.skills?.disabled) disabledIn.skills = name;
    if (layer.rules?.disabled) disabledIn.rules = name;
    const next = deepMerge(merged, fillHarness(layer, catalog));
    merged = file && name !== 'global' ? keepStricter(merged, next, file, warnings) : next;
  }

  const problems = checkConfigModels(merged, catalog);
  if (!enabledAxes(merged.review).length) problems.push(`review: at least one review axis (${REVIEW_AXES.join(', ')}) must be on`);
  if (merged.autonomy === 'custom' && !merged.gates) problems.push('autonomy: `custom` needs a `gates` list');
  if (problems.length) throw new ConfigError('after merging layers', problems);

  return {
    config: merged,
    profile: { ...profileRest, name: match.name, reason: match.reason },
    catalog,
    layers: [
      { name: 'defaults', present: true },
      { name: 'global', file: globalFile, present: !!global },
      { name: 'profile', present: match.reason !== 'none' },
      { name: 'workspace', file: workspaceFile, present: !!workspace },
      { name: 'repo', file: repoFile, present: !!repo },
      { name: 'flow', present: !!options.flow },
    ],
    globalDir: gDir,
    workspaceRoot,
    repoRoot,
    remote: git.remote,
    warnings,
    disabledIn,
  };
}

/**
 * Workspace/repo configs come from other people's repositories: they may not set anything that runs
 * host commands, weakens isolation or redirects credentials.
 */
const GLOBAL_ONLY: string[][] = [
  ['notify', 'command'],
  ['sandbox', 'mode'],
  // a repo may raise its own checks timeout, up to this ceiling
  ['review', 'checks_timeout_max'],
  // re-opens parts of the home directory to host sessions
  ['sandbox', 'host', 'read'],
  // profiles hold the tracker URL and token env name
  ['profiles'],
  ['default_profile'],
  ['workspaces'],
];

/** The sandbox image receives harness credentials and the allowlist is an exfiltration path. */
const REPO_FORBIDDEN: string[][] = [['sandbox']];

function checkGlobalOnly(layer: ConfigLayer, file: string, repoForbidden: string[][]): void {
  const present = (keys: string[]) => {
    let node: unknown = layer;
    for (const key of keys) node = (node as Record<string, unknown> | undefined)?.[key];
    return node !== undefined;
  };
  const problems = [
    ...repoForbidden.filter(present).map((keys) => `${keys.join('.')}: not allowed in a repo config (global/workspace only)`),
    ...GLOBAL_ONLY.filter(present).map((keys) => `${keys.join('.')}: allowed only in the global config (~/.agentic/config.yaml)`),
  ];
  if (problems.length) throw new ConfigError(file, problems);
}

/**
 * Workspace/repo layers may add safeguards but never remove them: a looser value is replaced by the stricter one
 * (with a warning). Loosening needs the global config or a CLI flag.
 */
function keepStricter(before: AgenticConfig, after: AgenticConfig, file: string, warnings: string[]): AgenticConfig {
  const result = structuredClone(after);
  const warn = (message: string) => warnings.push(`${file}: ${message}; the stricter value stays (to loosen: global config or a CLI flag)`);

  const gatesAfter = activeGates(after);
  const dropped = [...activeGates(before)].filter((gate) => !gatesAfter.has(gate));
  if (dropped.length) {
    result.autonomy = 'custom';
    result.gates = GATES.filter((gate) => gatesAfter.has(gate) || dropped.includes(gate));
    warn(`autonomy/gates dropped gates ${dropped.join(', ')}`);
  }
  for (const key of ['minutes', 'tokens', 'usd'] as const) {
    const was = before.budget[key];
    const now = after.budget[key];
    if (was !== undefined && (now === undefined || now > was)) {
      result.budget[key] = was;
      warn(`budget.${key} ${was} → ${now ?? 'none'}`);
    }
  }
  if (after.review.max_rounds > before.review.max_rounds) {
    result.review.max_rounds = before.review.max_rounds;
    warn(`review.max_rounds ${before.review.max_rounds} → ${after.review.max_rounds}`);
  }
  for (const axis of REVIEW_AXES) {
    if (before.review[axis] && !after.review[axis]) {
      result.review[axis] = before.review[axis];
      warn(`review.${axis} turned the axis off`);
    }
  }
  result.review.stop_on = strictestTriggers(before.review.stop_on, after.review.stop_on, warn);
  const silenced = before.notify.on.filter((event) => !after.notify.on.includes(event));
  if (silenced.length) {
    result.notify.on = [...after.notify.on, ...silenced];
    warn(`notify.on silenced ${silenced.join(', ')}`);
  }
  return result;
}

/** Union by trigger name; for thresholds the lowest wins (also among duplicates in one layer). */
function strictestTriggers(before: StopTrigger[], after: StopTrigger[], warn: (message: string) => void): StopTrigger[] {
  const thresholds = new Map<string, number | undefined>();
  const add = (trigger: StopTrigger) => {
    const [name, threshold] = triggerEntry(trigger);
    const current = thresholds.get(name);
    if (!thresholds.has(name) || (threshold !== undefined && (current === undefined || threshold < current))) thresholds.set(name, threshold);
  };
  after.forEach(add);
  const afterNames = new Map(after.map(triggerEntry));
  for (const trigger of before) {
    const [name, threshold] = triggerEntry(trigger);
    if (!afterNames.has(name)) warn(`review.stop_on removed \`${name}\``);
    else if (threshold !== undefined && (thresholds.get(name) ?? Infinity) > threshold) warn(`review.stop_on.${name} ${threshold} → ${thresholds.get(name)}`);
    add(trigger);
  }
  return [...thresholds].map(([name, threshold]) => (threshold === undefined ? name : { [name]: threshold }) as StopTrigger);
}

function triggerEntry(trigger: StopTrigger): [string, number | undefined] {
  if (typeof trigger === 'string') return [trigger, undefined];
  const [name, value] = Object.entries(trigger)[0] as [string, number];
  return [name, value];
}

function isWithin(dir: string, root: string | undefined): boolean {
  if (!root) return false;
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function registered(workspaceRoot: string, workspaces: string[] | undefined): boolean {
  return (workspaces ?? []).some((entry) => path.resolve(expandHome(entry)) === path.resolve(workspaceRoot));
}

function readLayer(file: string): ConfigLayer | undefined {
  if (!fs.existsSync(file)) return undefined;
  let data: unknown;
  try {
    data = parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof YAMLParseError) throw new ConfigError(file, [error.message]);
    throw error;
  }
  if (data == null) return {};
  validateLayer(data, file);
  return data as ConfigLayer;
}
