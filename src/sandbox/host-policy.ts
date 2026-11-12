import os from 'node:os';
import path from 'node:path';
import type { AgenticConfig } from '../config/types.js';
import { resolveImage } from './image.js';

/**
 * Credentials and harness/framework config: never readable by a session on the host, whatever the config says.
 * The home directory is closed anyway; these stay closed inside a re-opened part of it (e.g. `~/.m2/settings.xml`).
 */
export const SENSITIVE_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.azure',
  '~/.gnupg',
  '~/.password-store',
  '~/.netrc',
  '~/.git-credentials',
  '~/.config/git/credentials',
  '~/.config/gh',
  '~/.config/glab-cli',
  '~/.config/gcloud',
  '~/.docker',
  '~/.kube',
  '~/.npmrc',
  '~/.yarnrc.yml',
  '~/.pypirc',
  '~/.m2/settings.xml',
  '~/.m2/settings-security.xml',
  '~/.gradle/gradle.properties',
  '~/.vault-token',
  '~/.terraform.d',
  '~/.claude',
  '~/.claude.json',
  '~/.codex',
  // not the whole dir: a session works in its own flow under `~/.agentic/work/`; other flows stay closed with the home
  '~/.agentic/config.yaml',
  '~/.agentic/trusted-checks.yaml',
  '~/Library/Keychains',
] as const;

/** The framework's own dir: `sandbox.host.read` may not re-open it, it holds other flows' clones and artifacts. */
const FRAMEWORK_HOME = '~/.agentic';

/** Removed from the environment of the session's shell commands (Claude Code; Codex drops `*KEY*`/`*SECRET*`/`*TOKEN*` itself). */
export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'JIRA_API_TOKEN',
] as const;

/** Variable names that look like secrets (case-insensitive), besides `SECRET_ENV_VARS`. */
export const SECRET_ENV_PATTERN = 'KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL';

/** Names in `env` that look like secrets: the fixed list, and anything named like a key, token or password. */
export function secretEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = new Set<string>(SECRET_ENV_VARS);
  const secret = new RegExp(SECRET_ENV_PATTERN, 'i');
  return Object.keys(env).filter((name) => listed.has(name) || secret.test(name));
}

/**
 * What a session on the host (`sandbox.mode: none`) may read outside its own directories. The home directory
 * is closed; `read` re-opens parts of it (toolchains, dependency caches), `deny` closes more.
 */
export interface HostAccess {
  read: string[];
  deny: string[];
}

export function hostAccess(host: AgenticConfig['sandbox']['host'], home = os.homedir()): HostAccess {
  const deny = [...SENSITIVE_PATHS, ...host.deny];
  const expand = (entry: string) => path.resolve(entry.replace(/^~(?=\/|$)/, home));
  const problems = host.read.flatMap((entry) => {
    if (!entry.startsWith('~/') && !path.isAbsolute(entry)) return [`\`${entry}\`: expected an absolute path or \`~/…\``];
    const target = expand(entry);
    if (isWithin(home, target)) return [`\`${entry}\`: opens the whole home directory`];
    const covered = [...deny, FRAMEWORK_HOME].find((denied) => isWithin(target, expand(denied)));
    return covered ? [`\`${entry}\`: lies inside the protected \`${covered}\``] : [];
  });
  if (problems.length) throw new Error(`sandbox.host.read: ${problems.join('; ')}`);
  return { read: [...host.read], deny };
}

/** `inner` is `outer` itself or lies inside it. */
function isWithin(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The hosts a session's shell commands on the host may reach: the allowlist and what the repo's toolchain needs,
 * the same as in a container (`resolveImage`). Headless, a host off the list is denied — nobody approves it
 * (a pilot flow: no npm, no GitHub).
 */
export function hostNetwork(sandbox: AgenticConfig['sandbox'], repoRoot?: string): string[] {
  return [...new Set([...sandbox.network.allow, ...resolveImage(sandbox.image, repoRoot).hosts])];
}
