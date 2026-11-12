import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { loadConfig, repoRootOf, type LoadedConfig } from './config/load.js';
import { loadCatalog } from './config/models.js';
import { enabledAxes } from './config/review-axes.js';
import type { AgenticConfig, ContainerEngine, HarnessName } from './config/types.js';
import { errorMessage } from './errors.js';
import { harnessStatus } from './harness/cli.js';
import { checkCommands, hostCommands, MISSING_CHECKS } from './orchestrator/checks.js';
import { checksTrusted } from './config/trusted-checks.js';
import { testRunners, unreportedRunners } from './orchestrator/test-runners.js';
import { assertUniqueRuleIds, inactiveRules, ruleIdSet, skillSources, standardsSources } from './review/rules.js';
import { FRAMEWORK_RULE_PREFIX } from './review/rule-id.js';
import { STAGE_CONFIG_KEYS } from './config/schema.js';
import { sessionSkills, stageSkill } from './skills/stage.js';
import { CLAUDE_CREDENTIALS, claudeContainerEnv } from './harness/claude.js';
import { CODEX_CREDENTIALS, codexProvider, type CodexProvider } from './harness/codex.js';
import { hostAccess } from './sandbox/host-policy.js';
import { findLeftovers, type Leftovers } from './sandbox/clean.js';
import { CONTAINERS_FIX, containerTestSignals } from './sandbox/container-tests.js';
import { imageStatus, resolveImage, type ImageStatus } from './sandbox/image.js';
import { INIT_STEPS, isUndersized, podmanMachines, resizeSteps, shellLine, type PodmanMachine } from './sandbox/podman-machine.js';
import type { HarnessStatus } from './harness/types.js';
import { frameworkVersion, PACKAGE_ROOT, staleBuild, staleBuildWarning } from './paths.js';
import { forgeToken } from './publish/forge.js';
import { parseRemote } from './publish/remote.js';
import { GITLEAKS_FIX } from './publish/secrets.js';
import { repoReadiness } from './repo-readiness.js';

const exec = promisify(execFile);

/** `info` is a suggestion: never a problem, never fails the command. */
export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  harnessStatus?: (name: HarnessName) => Promise<HarnessStatus>;
  /** The engine's server version; undefined when it is missing or not running. */
  engineVersion?: (engine: ContainerEngine) => Promise<string | undefined>;
  imageStatus?: (engine: ContainerEngine, image: string, base: string) => Promise<ImageStatus>;
  leftovers?: (engine: ContainerEngine) => Promise<Leftovers>;
  /** Podman's VMs on macOS (`setup.ts`); undefined elsewhere or when the list fails. */
  podmanMachines?: () => Promise<PodmanMachine[] | undefined>;
  frameworkVersion?: string;
  /** A linked checkout's build older than its `src/` (`staleBuild`). */
  staleBuild?: () => { built: Date; changed: Date } | undefined;
  gitVersion?: () => Promise<string | undefined>;
  /** The name of an installed dictation app; undefined when none is found. */
  dictationApp?: () => Promise<string | undefined>;
  gitleaksVersion?: () => Promise<string | undefined>;
  forgeToken?: typeof forgeToken;
}

/** `git merge-tree --write-tree` (2.38) merges group branches without a working tree; `check-attr --source` (2.40) reads a commit's `.gitattributes` for the PR size. */
const MIN_GIT = '2.40.0';

const INSTALL: Record<HarnessName, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

const UPDATE: Record<HarnessName, string> = {
  claude: 'claude update',
  codex: 'npm install -g @openai/codex@latest',
};

export function usedHarnesses(config: AgenticConfig): Set<HarnessName> {
  const catalog = loadCatalog();
  const models = [
    ...Object.values(config.tiers).map((executor) => executor.model),
    ...Object.values(config.stages).flatMap((stage) => (stage.model ? [stage.model] : [])),
    ...enabledAxes(config.review).map(([, executor]) => executor.model),
    config.review.final.model,
    ...config.review.escalation,
  ];
  return new Set(models.flatMap((model) => (catalog.models[model] ? [catalog.models[model].harness] : [])));
}

export async function runDoctor(options: { cwd: string; env?: NodeJS.ProcessEnv }, deps: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(
    nodeMajor >= 20
      ? { name: 'node', level: 'ok', detail: process.versions.node }
      : { name: 'node', level: 'error', detail: `${process.versions.node} (needs ≥ 20)` },
  );

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig({ cwd: options.cwd, env: options.env });
  } catch (error) {
    checks.push({ name: 'config', level: 'error', detail: errorMessage(error) });
    return checks;
  }
  const present = loaded.layers.filter((layer) => layer.present).map((layer) => (layer.file ? `${layer.name} (${layer.file})` : layer.name));
  checks.push({ name: 'config', level: 'ok', detail: `layers: ${present.join(', ')}` });
  for (const warning of loaded.warnings) checks.push({ name: 'config', level: 'warn', detail: warning });
  checks.push({
    name: 'profile',
    level: loaded.profile.reason === 'none' ? 'warn' : 'ok',
    detail:
      loaded.profile.reason === 'none'
        ? 'no profile; define `profiles` in ~/.agentic/config.yaml'
        : `${loaded.profile.name} (match: ${loaded.profile.reason}, billing: ${loaded.profile.billing ?? '-'})`,
  });

  const version = deps.frameworkVersion ?? frameworkVersion();
  const required = loaded.config.requires_framework;
  if (required) {
    checks.push(
      semver.satisfies(version, required)
        ? { name: 'framework', level: 'ok', detail: `${version} (needs ${required})` }
        : { name: 'framework', level: 'error', detail: `${version}, the workspace needs ${required}`, fix: 'update agentic-framework' },
    );
  }

  const stale = (deps.staleBuild ?? staleBuild)();
  if (stale) checks.push({ name: 'framework', level: 'warn', ...staleBuildWarning(stale) });

  const catalog = loadCatalog();
  const statusOf = deps.harnessStatus ?? ((name: HarnessName) => harnessStatus(catalog.harnesses[name]));
  const used = usedHarnesses(loaded.config);
  for (const name of Object.keys(catalog.harnesses) as HarnessName[]) {
    const status = await statusOf(name);
    const minVersion = catalog.harnesses[name].min_version;
    if (!status.installed) {
      checks.push({
        name,
        level: used.has(name) ? 'error' : 'warn',
        detail: used.has(name) ? 'not installed, and the config uses it' : 'not installed (unused in the config)',
        fix: INSTALL[name],
      });
    } else if (minVersion && status.version && semver.valid(status.version) && semver.lt(status.version, minVersion)) {
      checks.push({ name, level: 'warn', detail: `${status.version} < ${minVersion} (the minimum from the model catalog)`, fix: UPDATE[name] });
    } else {
      checks.push({ name, level: 'ok', detail: status.version ?? 'installed' });
    }
  }

  checks.push(await gitCheck(deps.gitVersion ?? gitVersion));
  checks.push(await dictationCheck(deps.dictationApp ?? dictationApp));
  checks.push(await gitleaksCheck(deps.gitleaksVersion ?? gitleaksVersion));
  checks.push(await forgeCheck(loaded, deps.forgeToken ?? forgeToken, options.env));
  checks.push(checksCheck(loaded, options.cwd));
  checks.push(...testReportsChecks(loaded, options.cwd));
  checks.push(...rulesChecks(loaded, options.cwd));
  // a missing item is a suggestion: a repo works without a context map or standards, the agents just know less
  if (loaded.repoRoot) {
    for (const item of repoReadiness(loaded.repoRoot)) {
      checks.push(item.present ? { name: 'repo', level: 'ok', detail: [item.file, item.detail].filter(Boolean).join(' — ') } : { name: 'repo', level: 'info', detail: `no ${item.file}`, fix: item.detail });
    }
  }
  const { review } = loaded.config;
  if (review.on_stop.includes('escalate') && !review.escalation.length) {
    checks.push({
      name: 'review',
      level: 'warn',
      detail: '`on_stop: escalate` without a model ladder: skipped, the rest of the chain still works',
      fix: 'set `review.escalation` (e.g. `[sonnet, opus]`) or remove `escalate` from `review.on_stop`',
    });
  }
  if (review.stop_on.includes('budget')) {
    checks.push({
      name: 'review',
      level: 'warn',
      detail: '`stop_on: budget` changes nothing: the flow budget is always checked before each session',
      fix: 'remove `budget` from `review.stop_on`; `budget` sets the limits',
    });
  }

  const { sandbox } = loaded.config;
  if (sandbox.mode === 'container') {
    const version = await (deps.engineVersion ?? engineVersion)(sandbox.engine);
    const resolved = resolveImage(sandbox.image, repoRootOf(loaded, options.cwd));
    if (!version) {
      checks.push({ name: 'sandbox', level: 'error', detail: `${sandbox.engine} unavailable (sandbox.mode: container)`, fix: `${ENGINE_FIX[sandbox.engine]} or set \`sandbox.mode: none\`` });
    } else {
      // a stack layer is built on the base: both have to be there and current
      const images = resolved.image === resolved.base ? [resolved.base] : [resolved.base, resolved.image];
      const statuses = await Promise.all(images.map((image) => (deps.imageStatus ?? imageStatus)(sandbox.engine, image, resolved.base)));
      const missing = images.filter((_, index) => statuses[index] === 'missing');
      const stale = images.filter((_, index) => statuses[index] === 'stale');
      const fix = resolved.stack ? `\`agentic sandbox build\` (in this repo also ${resolved.image})` : '`agentic sandbox build`';
      const what = `image ${images.join(' + ')}${resolved.stack ? ` (stack ${resolved.stack})` : ''}`;
      if (missing.length) {
        checks.push({ name: 'sandbox', level: 'error', detail: `${sandbox.engine} ${version}, missing image ${missing.join(', ')}`, fix });
      } else if (stale.length) {
        checks.push({ name: 'sandbox', level: 'warn', detail: `${sandbox.engine} ${version}, image ${stale.join(', ')} built from another framework version${stale.includes(resolved.base) ? '' : ' or on another base image'}`, fix });
      } else {
        checks.push({ name: 'sandbox', level: 'ok', detail: `${sandbox.engine} ${version}, ${what}` });
      }
      if (sandbox.engine === 'podman') {
        const machines = await (deps.podmanMachines ?? defaultPodmanMachines)();
        const small = machines?.find((machine) => machine.running && isUndersized(machine));
        if (small) {
          checks.push({
            name: 'sandbox',
            level: 'warn',
            detail: `Podman machine ${small.name} has ${small.memoryMb} MB RAM; Gradle with tests in a container will run out of memory`,
            fix: `\`agentic setup\` or \`${shellLine(resizeSteps(small))}\``,
          });
        }
      }
      const leftovers = await (deps.leftovers ?? findLeftovers)(sandbox.engine).catch(() => ({ containers: [], networks: [] }));
      if (leftovers.containers.length || leftovers.networks.length) {
        checks.push({
          name: 'sandbox',
          level: 'warn',
          detail: `left over from interrupted sessions: ${leftovers.containers.length} containers, ${leftovers.networks.length} networks`,
          fix: '`agentic sandbox clean`',
        });
      }
    }
    const env = options.env ?? process.env;
    for (const harness of usedHarnesses(loaded.config)) {
      if (harness === 'claude') {
        checks.push(...claudeContainerChecks(env));
        continue;
      }
      const provider = codexProvider(env);
      if (provider) {
        checks.push(codexProviderCheck(provider, env));
        continue;
      }
      const names = CONTAINER_CREDENTIALS[harness];
      if (names.some((name) => env[name])) continue;
      checks.push({ name: 'sandbox', level: 'warn', detail: `${harness} in a container won't sign in: none of ${names.join(', ')}`, fix: CREDENTIALS_FIX[harness] });
    }
  } else {
    try {
      hostAccess(sandbox.host);
      checks.push({
        name: 'sandbox',
        level: 'warn',
        detail: "sandbox.mode: none, no container; sessions in the harness's sandbox (writes: clone and out/, home closed except sandbox.host.read)",
      });
    } catch (error) {
      checks.push({ name: 'sandbox', level: 'error', detail: errorMessage(error), fix: 'fix `sandbox.host.read` in ~/.agentic/config.yaml' });
    }
  }
  if (loaded.repoRoot) checks.push(...(await containerTestsChecks(loaded.repoRoot, loaded.config, deps.engineVersion ?? engineVersion)));
  return checks;
}

/**
 * Tests that start containers run where the checks run: in the session container they need `sandbox.containers`
 * (without it Testcontainers finds no Docker and the checks go red), on the host a running engine. A warning, not an
 * error: the signal is a heuristic, and `review.checks` may leave those tests to CI.
 */
async function containerTestsChecks(root: string, config: AgenticConfig, engineVersionOf: (engine: ContainerEngine) => Promise<string | undefined>): Promise<Check[]> {
  const { sandbox, review } = config;
  const name = 'container tests';
  const signals = containerTestSignals(root, review.checks === 'none' ? [] : review.checks);
  const found = signals.join(', ');
  if (sandbox.mode === 'none') {
    if (!signals.length) return [];
    for (const engine of ['docker', 'podman'] as const) {
      const version = await engineVersionOf(engine);
      if (version) return [{ name, level: 'ok', detail: `${found}; checks run on the host: ${engine} ${version}` }];
    }
    return [
      {
        name,
        level: 'warn',
        detail: `${found}; checks run on the host, and the host has no running Docker or Podman`,
        fix: "start Docker Desktop or `podman machine start` (Testcontainers with Podman: `DOCKER_HOST` on Podman's socket)",
      },
    ];
  }
  if (sandbox.containers) {
    if (signals.length) return [{ name, level: 'ok', detail: `${found}; \`sandbox.containers: true\`` }];
    return [
      {
        name,
        level: 'info',
        detail: '`sandbox.containers: true`, but the repo shows no Testcontainers or `docker compose`; the session container gets wider permissions and Docker Hub on the allowlist for it',
        fix: "turn it off if this repo's tests start no containers (doctor can't see dependencies under another name, e.g. an in-house library)",
      },
    ];
  }
  if (!signals.length) return [];
  return [{ name, level: 'warn', detail: `${found}; in the session container these tests find no Docker (\`sandbox.containers: false\`), checks will be red`, fix: CONTAINERS_FIX }];
}

async function gitVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['--version'], { timeout: 5000 });
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

async function gitCheck(version: () => Promise<string | undefined>): Promise<Check> {
  const found = await version();
  if (!found) return { name: 'git', level: 'error', detail: '`git` not found', fix: 'install git (e.g. `brew install git`)' };
  if (semver.lt(found, MIN_GIT)) return { name: 'git', level: 'error', detail: `${found} < ${MIN_GIT} (merging group branches, PR size in publish)`, fix: 'update git (e.g. `brew upgrade git`)' };
  return { name: 'git', level: 'ok', detail: found };
}

async function gitleaksVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await exec('gitleaks', ['version'], { timeout: 5000 });
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? stdout.trim();
  } catch {
    return undefined;
  }
}

/** `publish` scans the flow's commits before the push; without gitleaks it stops. */
async function gitleaksCheck(version: () => Promise<string | undefined>): Promise<Check> {
  const found = await version();
  if (found) return { name: 'gitleaks', level: 'ok', detail: found };
  return { name: 'gitleaks', level: 'warn', detail: "not found; `agentic publish` scans the flow's commits with it before the push", fix: GITLEAKS_FIX };
}

/** The profile's forge and whether its token is there; the token itself is never shown. */
async function forgeCheck(loaded: LoadedConfig, token: typeof forgeToken, env?: NodeJS.ProcessEnv): Promise<Check> {
  const forge = loaded.profile.forge;
  if (!forge || forge.type === 'none') {
    return {
      name: 'forge',
      level: 'info',
      detail: `${forge ? '`forge.type: none`' : 'no `forge` in the profile'}; publish pushes the branch and gives a link to create the PR`,
      ...(!forge && { fix: '`profiles.<name>.forge: { type: github, auth: { from: gh } }` in ~/.agentic/config.yaml' }),
    };
  }
  const remote = loaded.remote ? parseRemote(loaded.remote) : undefined;
  const host = forge.url ? new URL(forge.url).hostname : remote?.host;
  if (!host) return { name: 'forge', level: 'warn', detail: `${forge.type}: unknown host; no \`origin\` and no \`forge.url\`` };
  try {
    await token(forge, host, env);
    return { name: 'forge', level: 'ok', detail: `${forge.type} (${host}), token found` };
  } catch (error) {
    return { name: 'forge', level: 'warn', detail: errorMessage(error) };
  }
}

/** Speaking to the agent is faster than typing long grill answers; the framework suggests a tool, never requires it. */
const DICTATION_APPS = ['Handy', 'superwhisper', 'MacWhisper', 'VoiceInk', 'Wispr Flow'];

export async function dictationApp(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const dirs = ['/Applications', path.join(process.env.HOME ?? '', 'Applications')];
  return DICTATION_APPS.find((app) => dirs.some((dir) => fs.existsSync(path.join(dir, `${app}.app`))));
}

async function dictationCheck(app: () => Promise<string | undefined>): Promise<Check> {
  const found = await app();
  if (found) return { name: 'dictation', level: 'ok', detail: found };
  return {
    name: 'dictation',
    level: 'info',
    detail: 'no dictation app found; you answer grills faster by speaking than by typing',
    fix: process.platform === 'darwin' ? '`brew install --cask handy` (local, offline; docs/en/guides/dictation.md)' : 'Handy: https://handy.computer (docs/en/guides/dictation.md)',
  };
}

function checksCheck(loaded: LoadedConfig, cwd: string): Check {
  let commands: string[] | 'none';
  try {
    commands = checkCommands(loaded.config.review);
  } catch {
    const [problem, ...example] = MISSING_CHECKS.split('\n');
    return { name: 'checks', level: 'error', detail: problem!, fix: example.join('\n             ') };
  }
  if (commands === 'none') return { name: 'checks', level: 'warn', detail: '`review.checks: none`: groups are not verified (shown as unverified at gates)' };
  const list = commands.join(' && ');
  if (loaded.config.sandbox.mode === 'none' && !checksTrusted(loaded.globalDir, repoRootOf(loaded, cwd), hostCommands(loaded.config.review))) {
    return { name: 'checks', level: 'warn', detail: `${list}; no consent to run on the host`, fix: 'the first flow in this repo asks for consent' };
  }
  return { name: 'checks', level: 'ok', detail: list };
}

/**
 * Every test runner of `checks` writes JUnit XML that `review.test_reports` matches — otherwise the test gates
 * don't see its tests (a pilot flow: the glob took Gradle's reports, vitest wrote none, and the red gate
 * told the test author its tests were missing).
 */
function testReportsChecks(loaded: LoadedConfig, cwd: string): Check[] {
  const { review } = loaded.config;
  if (review.checks === 'none' || !review.checks.length) return [];
  const runners = testRunners(repoRootOf(loaded, cwd), review.checks);
  if (!runners.length) return [];
  const names = [...new Set(runners.map((runner) => runner.runner))].join(', ');
  if (!review.test_reports) {
    return [{ name: 'test reports', level: 'info', detail: `no \`review.test_reports\`; the test gates (${names}) only look at exit codes`, fix: 'a glob of JUnit XML reports relative to the clone, e.g. `**/build/test-results/**/*.xml`' }];
  }
  const gaps = unreportedRunners(runners, review.test_reports);
  if (!gaps.length) return [{ name: 'test reports', level: 'ok', detail: `${review.test_reports} (${names})` }];
  return gaps.map(({ runner, why }) => {
    const where = `${runner.runner} in \`${runner.command}\`${runner.dir === '.' ? '' : ` (${runner.dir})`}`;
    return why === 'no-junit'
      ? { name: 'test reports', level: 'warn' as const, detail: `${where} writes no JUnit XML; the gates won't see its tests`, fix: `${JUNIT_FIX[runner.runner] ?? 'turn on a JUnit reporter'} and cover the file with the \`review.test_reports\` glob` }
      : { name: 'test reports', level: 'warn' as const, detail: `${where} writes its report to \`${runner.sample}\`, which \`review.test_reports\` (\`${review.test_reports}\`) doesn't cover`, fix: 'widen the glob to this file' };
  });
}

const JUNIT_FIX: Record<string, string> = {
  vitest: "vitest: `reporters: ['default', 'junit'], outputFile: { junit: 'build/test-results/vitest/junit.xml' }` in the `test` config",
  jest: "jest: `reporters: ['default', ['jest-junit', { outputDirectory: 'build/test-results/jest' }]]` (the `jest-junit` package)",
  playwright: "playwright: `reporter: [['list'], ['junit', { outputFile: 'build/test-results/e2e/junit.xml' }]]`",
};

/** Rule ids are unique; which framework rules are active, and what `skills.disabled` / `rules.disabled` switched off where. */
function rulesChecks(loaded: LoadedConfig, cwd: string): Check[] {
  const { config, disabledIn } = loaded;
  const root = repoRootOf(loaded, cwd);
  try {
    assertUniqueRuleIds(config, root);
  } catch (error) {
    const [problem, ...details] = errorMessage(error).split('\n');
    return [{ name: 'rules', level: 'error', detail: problem!, fix: details.join('\n             ') }];
  }
  const checks: Check[] = [];
  const skills = [...new Set(STAGE_CONFIG_KEYS.flatMap((kind) => sessionSkills(config, kind)))];
  const sources = [...standardsSources(root), ...skillSources(skills, root)];
  const ids = ruleIdSet(sources);
  const inactive = inactiveRules(config, sources);
  const framework = [...ids].filter((id) => id.startsWith(FRAMEWORK_RULE_PREFIX));
  const off = [...inactive].map(([id, reason]) => `${id} (${reason === 'rules.disabled' ? `rules.disabled: ${disabledIn.rules}` : 'checked-by'})`);
  const disabledSkills = config.skills?.disabled ?? [];
  checks.push({
    name: 'rules',
    level: 'ok',
    detail: [
      `IDs without collisions; framework rules active: ${framework.filter((id) => !inactive.has(id)).length}/${framework.length}`,
      ...(off.length ? [`off: ${off.join(', ')}`] : []),
      ...(disabledSkills.length ? [`skills off (skills.disabled: ${disabledIn.skills}): ${disabledSkills.join(', ')}`] : []),
    ].join('; '),
  });

  const unknownRules = (config.rules?.disabled ?? []).filter((id) => !ids.has(id));
  if (unknownRules.length) {
    checks.push({ name: 'rules', level: 'warn', detail: `rules.disabled: no such rules in the standards or stage skills: ${unknownRules.join(', ')}`, fix: 'fix the ID or remove the entry' });
  }
  const stageSkills = new Set(STAGE_CONFIG_KEYS.map((kind) => config.stages[kind]?.stage_skill ?? stageSkill(kind)));
  const practice = new Set(STAGE_CONFIG_KEYS.flatMap((kind) => config.stages[kind]?.skills ?? []));
  const notPractice = disabledSkills.filter((skill) => !practice.has(skill));
  if (notPractice.length) {
    checks.push({
      name: 'rules',
      level: 'warn',
      detail: `skills.disabled: not a practice skill of any stage: ${notPractice.join(', ')}${notPractice.some((skill) => stageSkills.has(skill)) ? ' (a stage skill cannot be turned off; replace it with `stage_skill`)' : ''}`,
    });
  }
  if (config.review.checks === 'none' && sources.some((source) => /checked[ -]by:/i.test(source.text.replaceAll(/[_*]/g, '')))) {
    checks.push({ name: 'rules', level: 'warn', detail: 'rules with `Checked by:` stay with the reviewer: `review.checks: none`, so nothing checks them' });
  }
  return checks;
}

/**
 * Claude Code in a container signs in with a variable from the shell or from `settings.json`'s `env`; a company gateway
 * goes through the session's egress proxy, which tunnels HTTPS on 443 only.
 */
function claudeContainerChecks(env: NodeJS.ProcessEnv): Check[] {
  const { values, fromSettings, settingsFile } = claudeContainerEnv(env);
  if (!CLAUDE_CREDENTIALS.some((name) => values[name])) {
    return [{ name: 'sandbox', level: 'warn', detail: `claude in a container won't sign in: none of ${CLAUDE_CREDENTIALS.join(', ')}`, fix: CREDENTIALS_FIX.claude }];
  }
  if (!values.ANTHROPIC_BASE_URL) return [];
  const where = fromSettings.includes('ANTHROPIC_BASE_URL') ? ` (from ${settingsFile})` : '';
  const problem = gatewayProblem('claude', values.ANTHROPIC_BASE_URL, where);
  if (problem) return [problem];
  return [{ name: 'sandbox', level: 'ok', detail: `claude in a container through gateway ${new URL(values.ANTHROPIC_BASE_URL).hostname}${where}, host added to the session allowlist` }];
}

/** Codex with its own provider (a company gateway) signs in with the provider's `env_key`. */
function codexProviderCheck(provider: CodexProvider, env: NodeJS.ProcessEnv): Check {
  const source = `provider ${provider.name} from ${provider.configFile}`;
  const missing = provider.passEnv.filter((name) => !env[name]);
  if (missing.length) {
    return { name: 'sandbox', level: 'warn', detail: `codex in a container won't sign in: missing ${missing.join(', ')} (${source})`, fix: `\`export ${missing[0]}=…\` in your shell profile` };
  }
  if (!provider.baseUrl) return { name: 'sandbox', level: 'ok', detail: `codex in a container through ${source}` };
  return (
    gatewayProblem('codex', provider.baseUrl, ` (${source})`) ?? {
      name: 'sandbox',
      level: 'ok',
      detail: `codex in a container through provider ${provider.name} (${provider.host}, from ${provider.configFile}), host added to the session allowlist`,
    }
  );
}

/** The session's egress proxy tunnels HTTPS on 443 only: a gateway elsewhere is unreachable from a container. */
function gatewayProblem(harness: HarnessName, baseUrl: string, where: string): Check | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { name: 'sandbox', level: 'warn', detail: `${harness} in a container: the gateway address${where} is not a URL` };
  }
  if (url.protocol === 'https:' && (!url.port || url.port === '443')) return undefined;
  return {
    name: 'sandbox',
    level: 'warn',
    detail: `${harness} in a container: gateway ${url.host}${where}; the session proxy only lets HTTPS on port 443 through`,
    fix: 'an `https://` gateway address without another port (e.g. through its ingress) or `sandbox.mode: none`',
  };
}

/** A container reaches no keychain and no `~/.claude`: the harness signs in with a variable passed by name. */
const CONTAINER_CREDENTIALS: Record<HarnessName, readonly string[]> = { claude: CLAUDE_CREDENTIALS, codex: CODEX_CREDENTIALS };

const CREDENTIALS_FIX: Record<HarnessName, string> = {
  claude: 'subscription: `claude setup-token`, then `export CLAUDE_CODE_OAUTH_TOKEN=…` in your shell profile; or `ANTHROPIC_API_KEY`; a company gateway: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (in the shell or in `env` in ~/.claude/settings.json)',
  codex: '`export CODEX_API_KEY=…` (the ChatGPT sign-in from `~/.codex` does not reach the container)',
};

const ENGINE_FIX: Record<ContainerEngine, string> = {
  podman: `\`agentic setup\` or \`brew install podman && ${shellLine(INIT_STEPS)}\` (machine already there: \`podman machine start\`)`,
  docker: 'start Docker Desktop',
};

/** Both query the server, so a stopped podman machine or Docker daemon counts as unavailable. */
const ENGINE_VERSION_ARGS: Record<ContainerEngine, string[]> = {
  podman: ['info', '--format', '{{.Version.Version}}'],
  docker: ['version', '--format', '{{.Server.Version}}'],
};

/** Only macOS runs Podman in a VM. */
function defaultPodmanMachines(): Promise<PodmanMachine[] | undefined> {
  return process.platform === 'darwin' ? podmanMachines() : Promise.resolve(undefined);
}

async function engineVersion(engine: ContainerEngine): Promise<string | undefined> {
  try {
    const { stdout } = await exec(engine, ENGINE_VERSION_ARGS[engine], { timeout: 8000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
