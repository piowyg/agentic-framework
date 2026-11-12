import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { stringify } from 'yaml';
import { loadConfig, repoRootOf, type LoadedConfig } from '../config/load.js';
import { loadCatalog } from '../config/models.js';
import { AUTONOMY } from '../config/schema.js';
import { activeGates } from '../config/gates.js';
import { writeTestsEnabled } from '../orchestrator/write-tests.js';
import { checksTrusted, trustChecks, trustFile } from '../config/trusted-checks.js';
import { checkCommands, hostCommands } from '../orchestrator/checks.js';
import { assertUniqueRuleIds } from '../review/rules.js';
import type { AgenticConfig, Autonomy } from '../config/types.js';
import { dictationApp, runDoctor, type CheckLevel } from '../doctor.js';
import { runInit } from '../init.js';
import { runSetup } from '../setup.js';
import { frameworkSkills, installSkills, linkState, SKILL_TARGETS, uninstallSkills, type InstallResult } from '../skills/install.js';
import { FRAMEWORK_SKILLS_DIR } from '../skills/stage.js';
import { frameworkVersion, staleBuild, staleBuildWarning } from '../paths.js';
import { cliRegistry } from '../harness/index.js';
import { fakeRegistry } from '../harness/fake.js';
import { createFlow, runFlow, unfinishedFlows, unfinishedPicks, type FlowContext } from '../orchestrator/flow.js';
import { flowRunning } from '../orchestrator/lock.js';
import { listFlows, loadState, reviewSummary, saveState, STAGES, type FlowOrigin, type FlowState, type FlowTarget } from '../orchestrator/state.js';
import { rebaseFeature } from '../orchestrator/rebase.js';
import { rebuildStack } from '../orchestrator/restack-rebase.js';
import { restackFlow, type RestackPlan } from '../publish/restack.js';
import { hostGit } from '../orchestrator/repos.js';
import {
  renderCategories,
  renderTree,
  renderUnpriced,
  renderYield,
  reviewYield,
  usageBy,
  usageCategories,
  usageTree,
  type UsageDimension,
} from '../orchestrator/usage-report.js';
import { readUsage, summarizeUsage } from '../orchestrator/usage.js';
import { notifier } from '../orchestrator/notify.js';
import { workRoot, workRoots } from '../orchestrator/workdir.js';
import { probeNetwork } from '../orchestrator/network.js';
import { createSandbox } from '../sandbox/index.js';
import { cacheVolumes, findLeftovers, removeLeftovers, removeVolumes } from '../sandbox/clean.js';
import { BASE_IMAGE, buildImage, reclaimSpace, resolveImage, STACKS } from '../sandbox/image.js';
import { podmanMachines } from '../sandbox/podman-machine.js';
import { publishFlow, type PublishPlan, type StackPullRequest } from '../publish/publish.js';
import { linesText, thresholdsText } from '../publish/size.js';
import { flowTarget } from '../publish/target.js';
import { cleanAll, cleanOne, offerAfterEnd, type CleanOptions } from './clean.js';
import { sanitize } from './sanitize.js';
import { classifyTicket, pastedTitle } from './paste.js';
import { PASTE_END, TtyGates } from './tty-gates.js';
import { LiveLine } from './live-line.js';
import { plural } from '../plural.js';

interface RunOptions {
  autonomy?: Autonomy;
  fake?: boolean;
}

type StartOptions = RunOptions & { base?: string };

// Output may carry text from foreign configs or agent artifacts.
const say = (text: string) => console.log(sanitize(text));

/** CLI definition; also the source of docs/reference/commands.md. */
export function buildProgram(): Command {
  const program = new Command('agentic')
    .description('A structured workflow for coding agents: grill → ticket/spec → breakdown → TDD in a sandbox → review → PR.')
    .version(frameworkVersion());

  const runOptions = (command: Command) =>
    command
      .addOption(new Option('--autonomy <preset>', 'gate preset (saved in the flow; resume remembers it)').choices([...AUTONOMY]))
      .addOption(new Option('--fake', 'fake harness (no tokens), for trials and demos').default(false));

  const baseOption = () => new Option('--base <branch>', "the PR's target branch: the flow starts from its state on origin; defaults to origin's default branch");

  runOptions(
    program
      .command('new')
      .description('A new flow from your own idea: business grill → ticket → … → ready to publish.')
      .argument('[idea]', 'a short description of the idea (the slug comes from it); without it you paste a longer description in the terminal'),
  )
    .addOption(baseOption())
    .action(async (summary: string | undefined, options: StartOptions) => {
    const overrides = options.autonomy ? { autonomy: options.autonomy } : undefined;
    const { loaded, root, roots } = context(overrides);
    preflight(loaded);
    const gates = new TtyGates();
    const idea = summary ? undefined : await paste(gates, 'Paste the idea');
    const target = startTarget(loaded, options.base);
    const { workDir, slug } = createFlow({ workRoot: root, otherRoots: roots, title: summary ?? pastedTitle(idea!), entry: 'new', origin: flowOrigin(loaded), target, idea, overrides });
    say(`Flow ${slug} → ${workDir}`);
    await execute(workDir, loaded, options, gates);
  });

  runOptions(
    program
      .command('pick')
      .description('A flow from a ready ticket (markdown with ACs, from a file or pasted); starts at the technical grill. Pulling from a tracker is planned.')
      .argument('[ticket]', 'path to ticket.md; without it you paste the ticket in the terminal'),
  )
    .addOption(new Option('--new', 'a new flow, even when this ticket has a paused one').default(false))
    .addOption(baseOption())
    .action(async (ticketPath: string | undefined, options: StartOptions & { new?: boolean }) => {
      const overrides = options.autonomy ? { autonomy: options.autonomy } : undefined;
      const { loaded, root, roots } = context(overrides);
      preflight(loaded);
      const gates = new TtyGates();
      const ticket = ticketPath ? fs.readFileSync(ticketPath, 'utf8') : await paste(gates, 'Paste the ticket');
      const classified = classifyTicket(ticket, ticketPath ? path.basename(path.dirname(path.resolve(ticketPath))) : undefined);
      if (classified.kind === 'idea') {
        say(`This is not a ticket ready for the technical grill:\n${classified.problems.map((problem) => `  - ${problem}`).join('\n')}`);
        if (!(await gates.confirm('Start with the business grill, which turns this text into a ticket?'))) return gates.close();
        const target = startTarget(loaded, options.base);
        const { workDir, slug } = createFlow({ workRoot: root, otherRoots: roots, title: classified.title, entry: 'new', origin: flowOrigin(loaded), target, idea: ticket, overrides });
        say(`Flow ${slug} → ${workDir}`);
        return execute(workDir, loaded, options, gates);
      }
      const { title } = classified;
      const [unfinished] = options.new ? [] : unfinishedPicks(roots, title, flowOrigin(loaded));
      if (unfinished) {
        say(`Ticket ${title} has an unfinished flow ${unfinished.slug} (${unfinished.status}, stage ${unfinished.stage}).`);
        if (await gates.confirm(`Resume ${unfinished.slug}? Otherwise a new flow starts (without asking: --new).`)) return resumeFlow(unfinished.slug, options, gates);
      }
      const target = startTarget(loaded, options.base);
      const { workDir, slug } = createFlow({ workRoot: root, otherRoots: roots, title, entry: 'pick', origin: flowOrigin(loaded), target, ticket, overrides });
      say(`Flow ${slug} → ${workDir}`);
      await execute(workDir, loaded, options, gates);
    });

  runOptions(
    program
      .command('resume')
      .description('Resumes a paused flow where it stopped (with the gate preset saved in the flow).')
      .argument('[slug]', "the flow's slug; without it you pick from this repo's paused flows"),
  ).action(async (slug: string | undefined, options: RunOptions) => {
    if (slug) return resumeFlow(slug, options);
    const { loaded, roots } = context();
    const flows = unfinishedFlows(roots, flowOrigin(loaded));
    if (!flows.length) return say('No paused flows in this repo (`agentic status` lists them all).');
    if (!process.stdin.isTTY) throw new Error('Give a slug: agentic resume <slug> (list: agentic status).');
    const gates = new TtyGates();
    const chosen = await gates.choose('Which flow to resume?', flows.map(describeUnfinished));
    if (chosen === undefined) return gates.close();
    await resumeFlow(flows[chosen]!.slug, options, gates);
  });

  program
    .command('status')
    .description('Lists flows, or details of one (stages, groups, pause, usage).')
    .argument('[slug]', "the flow's slug")
    .action((slug?: string) => {
      const { root, roots } = context();
      if (slug) printFlow(flowDir(roots, slug));
      else printFlows(root, roots);
    });

  program
    .command('publish')
    .description(
      "Publishes a finished flow: secret scan (gitleaks) → push of a branch named by `git.branch_pattern` → PR/MR through the profile's forge (`none`: a link to create it) → cleanup of work branches and clones. With `publish.stack` a chain of groups becomes a stack: a PR per group on the previous one's branch, the lowest ready, the rest as drafts. Running it again updates the same PRs.",
    )
    .argument('[slug]', "the flow's slug; without it you pick from this repo's finished flows")
    .option('--base <branch>', "the PR's target branch; defaults to the one chosen at the flow's start (another one: rebase onto it before the push)")
    .option('--single', 'one PR for everything instead of a stack of PRs (this once, like `publish.stack: false`)', false)
    .option('--yes', 'no confirmation prompt', false)
    .action((slug: string | undefined, options: PublishCliOptions) => publish(slug, options));

  program
    .command('restack')
    .description(
      "Rebuilds a published stack of PRs: PR state from the forge; after the lowest ones merge (squash too) the rest moves onto the target (`rebase --onto`), after human commits in a lower PR the higher ones are rebuilt on them. `review.checks` after each branch; a conflict → a merge session and the merge gate. Then `push --force-with-lease` (after confirmation), the new lowest PR retargeted and out of draft, stack lists in the descriptions. Interrupted (a gate, manual resolution): running it again continues.",
    )
    .argument('<slug>', "the published flow's slug")
    .option('--yes', 'no confirmation prompt before the force-push', false)
    .action((slug: string, options: { yes?: boolean }) => restack(slug, options));

  program
    .command('clean')
    .description(
      'Cleans up what flows leave behind: work directories (clones, bundles, check logs, transcripts), hidden rollback refs and `agentic/<slug>/*` branches. Audit artifacts (ticket, spec, tasks, review reports, usage, events) stay. A branch with commits that exist nowhere else (another branch, a tag, a remote) goes only after confirmation.',
    )
    .argument('[slug]', "one flow, a paused one too, which then ends; without it: this repo's finished flows and flow branches whose directory is gone")
    .option('--dry-run', 'only show what would go and how much space it takes', false)
    .option('--yes', 'no prompt; branches holding the only copy of work stay', false)
    .action((slug: string | undefined, options: { dryRun: boolean; yes: boolean }) => clean(slug, options));

  program
    .command('usage')
    .description("A flow's tokens and cost broken down: stage → group → task / review round / fix.")
    .argument('<slug>', "the flow's slug")
    .addOption(new Option('--by <dimension>', 'a flat breakdown by one dimension').choices(['kind', 'model', 'stage', 'group', 'task']))
    .option('--json', 'output as JSON', false)
    .action((slug: string, options: { by?: UsageDimension; json?: boolean }) => {
      const { roots, loaded } = context();
      const records = readUsage(flowDir(roots, slug));
      const pricing = loaded.profile.pricing ?? {};
      const tree = usageTree(records, pricing);
      if (options.by) {
        const rows = usageBy(records, options.by, pricing);
        if (options.json) return say(JSON.stringify(rows, null, 2));
        return say(renderTree({ ...tree, children: rows }, `${slug} by ${options.by}`));
      }
      if (options.json) return say(JSON.stringify(tree, null, 2));
      say(renderTree(tree, slug));
      say(renderCategories(usageCategories(records, pricing), tree));
      const state = loadState(flowDir(roots, slug));
      const reviewed = renderYield(reviewYield(records, [...Object.values(state.groups), ...(state.final_review ? [state.final_review] : [])]));
      if (reviewed) say(reviewed);
      if (tree.estimated) say("≈ cost computed from the profile's `pricing` (the harness reported none).");
      const unpriced = renderUnpriced(tree);
      if (unpriced) say(unpriced);
      if (loaded.profile.billing === 'subscription') say('Subscription profile: $ is the equivalent at API prices, not real spend.');
    });

  program
    .command('doctor')
    .description("Checks the environment: config, profile, harness CLIs, Docker, the framework version, and in a service repo also what `agentic init` shows at the end. Changes nothing.")
    .action(async () => {
      const checks = await runDoctor({ cwd: process.cwd() });
      const icon: Record<CheckLevel, string> = { ok: '✓', info: 'i', warn: '!', error: '✗' };
      for (const check of checks) {
        say(`${icon[check.level]} ${check.name.padEnd(10)} ${check.detail}`);
        if (check.fix) say(`  ${''.padEnd(10)} → ${check.fix}`);
      }
      if (checks.some((check) => check.level === 'error')) process.exitCode = 1;
    });

  program
    .command('init')
    .description('Prepares a service repo: `.agentic/config.yaml` with `review.checks` of the detected build (Gradle, Maven, npm) and a ticket template, and adds an `## Agentic` section to an existing `AGENTS.md`. Shows and asks before writing; overwrites nothing. At the end (also on a rerun) shows what the repo has for agents: a context map, `AGENTS.md` / `CLAUDE.md`, the `architecture.md` / `testing.md` / `code.md` standards, and what to make the rest with.')
    .option('--yes', 'write without asking (e.g. without a terminal)', false)
    .action(async (options: { yes?: boolean }) => {
      const gates = new TtyGates();
      try {
        await runInit(
          { cwd: process.cwd(), yes: options.yes },
          { confirm: (question) => gates.confirm(question), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), say },
        );
      } finally {
        gates.close();
      }
    });

  program
    .command('setup')
    .description('Prepares the environment with your consent: Podman for container sessions (install through brew, a machine on macOS) and (once) a dictation app.')
    .action(async () => {
      const gates = new TtyGates();
      try {
        await runSetup(
          { sandbox: loadConfig({ cwd: process.cwd() }).config.sandbox },
          {
            podman: { version: podmanVersion, machines: podmanMachines },
            dictationApp,
            platform: process.platform,
            hasBrew: () => new Promise((resolve) => execFile('brew', ['--version'], (error) => resolve(!error))),
            run: (command, args) =>
              new Promise((resolve) => spawn(command, args, { stdio: 'inherit' }).on('error', () => resolve(false)).on('close', (code) => resolve(code === 0))),
            confirm: (question) => gates.confirm(question),
            interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
            say,
            today: () => new Date().toISOString().slice(0, 10),
          },
        );
      } finally {
        gates.close();
      }
    });

  const sandbox = program.command('sandbox').description('The session container (`sandbox.mode: container`).');
  sandbox
    .command('build')
    .description(
      "Builds session images with the `sandbox.engine` engine: the base (`agentic/base`: git, Claude Code, Codex, Node) and this repo's stack layer (`sandbox.image.stack`, e.g. `agentic/jvm` with JDK 17/21/25). After a framework update `doctor` suggests a rebuild. At the end removes replaced framework images, and with Podman on macOS returns the freed space from the virtual machine's disk.",
    )
    .option('--stack <stack>', `the stack layer to build instead of the one detected in the repo (${Object.keys(STACKS).join(', ')})`)
    .action(async (options: { stack?: string }) => {
      const loaded = loadConfig({ cwd: process.cwd() });
      const { engine, image } = loaded.config.sandbox;
      if (options.stack && !(options.stack in STACKS)) throw new Error(`--stack: allowed values: ${Object.keys(STACKS).join(', ')}`);
      const resolved = resolveImage(options.stack ? { ...image, stack: options.stack } : image, repoRootOf(loaded));
      const images = [...(image.base === BASE_IMAGE ? [BASE_IMAGE] : []), ...(resolved.stack ? [resolved.image] : [])];
      if (image.base !== BASE_IMAGE) say(`${image.base} is your own base image; you build it yourself.`);
      if (resolved.image !== resolved.base && !resolved.stack) say(`${resolved.image} is your own stack image; you build it yourself.`);
      for (const name of images) {
        say(`${engine} build → ${name}`);
        const exitCode = await buildImage(engine, name, image.base);
        if (exitCode !== 0) {
          say(`✗ ${engine} build exited with code ${exitCode}`);
          process.exitCode = 1;
          return;
        }
      }
      await reclaimSpace(engine);
    });

  sandbox
    .command('clean')
    .description(
      "Removes session containers and networks left by an `agentic` process that is gone (crash, SIGKILL); a running flow's sessions are left alone. `--caches` also removes the dependency cache volumes.",
    )
    .option('--caches', 'also remove the `agentic-cache-*` volumes (the next build downloads dependencies again)')
    .action(async (options: { caches?: boolean }) => {
      const { engine } = loadConfig({ cwd: process.cwd() }).config.sandbox;
      const leftovers = await findLeftovers(engine);
      const volumes = options.caches ? await cacheVolumes(engine) : [];
      if (!leftovers.containers.length && !leftovers.networks.length && !volumes.length) {
        say('Nothing to clean up.');
        return;
      }
      for (const name of leftovers.containers) say(`- container ${name}`);
      for (const name of leftovers.networks) say(`- network ${name}`);
      for (const name of volumes) say(`- volume ${name}`);
      await removeLeftovers(engine, leftovers);
      if (!(await removeVolumes(engine, volumes))) {
        say('✗ some volumes are in use (a running session?); they stay');
        process.exitCode = 1;
      }
    });

  const skills = program
    .command('skills')
    .description("The framework's skills in your own Claude Code and Codex sessions (not in flows: a flow takes skills from the config).");
  skills
    .command('list', { isDefault: true })
    .description("The framework's skills and where they are installed.")
    .action(() => {
      const home = os.homedir();
      const all = frameworkSkills();
      const width = Math.max(...all.map((skill) => skill.name.length));
      const brief = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text);
      say('Practices (`agentic skills install` links them into Claude Code and Codex):');
      for (const skill of all.filter((each) => !each.stage)) {
        const where = SKILL_TARGETS.map(({ harness, dir }) => {
          const state = linkState(path.join(home, dir, skill.name), path.join(FRAMEWORK_SKILLS_DIR, skill.name));
          return `${harness} ${{ linked: '✓', missing: '·', 'other-link': '↷', taken: '!' }[state]}`;
        });
        say(`  ${skill.name.padEnd(width)}  ${where.join('  ')}  ${brief(skill.description)}`);
      }
      say('Flow stages (session contracts, not installed):');
      for (const skill of all.filter((each) => each.stage)) say(`  ${skill.name.padEnd(width)}  ${brief(skill.description)}`);
      say('✓ linked, · missing, ↷ links elsewhere (install relinks), ! your own file with this name (install skips it)');
    });
  skills
    .command('install')
    .description('Links the practices into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex). Idempotent; leaves a file or directory with the same name alone.')
    .action(() => {
      const labels: Record<InstallResult, string> = { linked: '✓ linked', already: '· already there', relinked: '↷ relinked', skipped: '! skipped: your own file with this name' };
      for (const { harness, skill, result } of installSkills(os.homedir())) say(`${labels[result]}: ${skill} (${harness})`);
    });
  skills
    .command('uninstall')
    .description("Removes the links to this framework's skills; nothing else.")
    .action(() => {
      const removed = uninstallSkills(os.homedir());
      for (const { harness, skill } of removed) say(`✓ removed: ${skill} (${harness})`);
      if (!removed.length) say('· nothing to remove');
    });

  const config = program.command('config').description('Inspect the config.');
  config
    .command('show')
    .description('The merged config (all layers + profile) as YAML.')
    .action(() => {
      const loaded = loadConfig({ cwd: process.cwd() });
      say(`# profile: ${loaded.profile.name ?? '(none)'} (${loaded.profile.reason})`);
      for (const layer of loaded.layers) say(`# ${layer.present ? '✓' : '·'} ${layer.name}${layer.file ? ` ${layer.file}` : ''}`);
      for (const warning of loaded.warnings) say(`# ! ${warning}`);
      say(stringify(loaded.config));
    });

  program
    .command('models')
    .description("The framework's model catalog (alias → harness, ID, efforts).")
    .action(() => {
      for (const [alias, model] of Object.entries(loadCatalog().models)) {
        say(`${alias.padEnd(8)} ${model.harness.padEnd(7)} ${model.id.padEnd(28)} ${model.efforts.join(', ')}`);
      }
    });

  return program;
}

interface PublishCliOptions {
  base?: string;
  single?: boolean;
  yes?: boolean;
}

async function publish(slug: string | undefined, options: PublishCliOptions): Promise<void> {
  const { loaded, roots } = context();
  for (const warning of loaded.warnings) say(`! ${warning}`);
  const here = flowOrigin(loaded);
  const gates = new TtyGates();
  try {
    const chosen = slug ?? (await chooseReady(roots, here, gates));
    if (!chosen) return;
    const dir = flowDir(roots, chosen);
    const { origin } = loadState(dir);
    // state.json lives where agents write; don't let it point the push at another repo
    if (path.resolve(origin.repoRoot) !== here.repoRoot) {
      throw new Error(`Flow \`${chosen}\` belongs to ${describeOrigin(origin)}, not to ${describeOrigin(here)}; run publish from that repo.`);
    }
    const published = await publishFlow({
      workDir: dir,
      config: loaded.config,
      forge: loaded.profile.forge,
      profileName: loaded.profile.name,
      framework: frameworkVersion(),
      base: options.base,
      single: options.single,
      log: say,
      rebase: async (request) => {
        const runtime = sessionRuntime(false, loaded);
        const checksTrusted = runtime.sandbox.isolated || (await confirmChecks(loaded, gates));
        return rebaseFeature({ workDir: dir, config: loaded.config, catalog: loaded.catalog, profile: loaded.profile, ...runtime, gates, checksTrusted, log: say }, request);
      },
      confirm: async (plan) => {
        say(describePlan(plan));
        return options.yes || gates.confirm(plan.stack ? `Push ${plural(plan.stack.length, 'branch', 'branches')} and open a stack of PRs?` : 'Push the branch and open a PR?');
      },
    });
    if (!published) say('Nothing pushed.');
  } finally {
    gates.close();
  }
}

async function restack(slug: string, options: { yes?: boolean }): Promise<void> {
  const { loaded, roots } = context();
  for (const warning of loaded.warnings) say(`! ${warning}`);
  const here = flowOrigin(loaded);
  const gates = new TtyGates();
  try {
    const dir = flowDir(roots, slug);
    const { origin } = loadState(dir);
    // state.json lives where agents write; don't let it point the force-push at another repo
    if (path.resolve(origin.repoRoot) !== here.repoRoot) {
      throw new Error(`Flow \`${slug}\` belongs to ${describeOrigin(origin)}, not to ${describeOrigin(here)}; run restack from that repo.`);
    }
    const result = await restackFlow({
      workDir: dir,
      config: loaded.config,
      forge: loaded.profile.forge,
      profileName: loaded.profile.name,
      framework: frameworkVersion(),
      log: say,
      rebuild: async (request) => {
        const runtime = sessionRuntime(false, loaded);
        const checksTrusted = runtime.sandbox.isolated || (await confirmChecks(loaded, gates));
        return rebuildStack({ workDir: dir, config: loaded.config, catalog: loaded.catalog, profile: loaded.profile, ...runtime, gates, checksTrusted, log: say }, request);
      },
      confirm: async (plan) => {
        say(describeRestackPlan(plan));
        return options.yes || gates.confirm(plan.push.length ? `Push ${plural(plan.push.length, 'branch', 'branches')} with --force-with-lease and update the PRs?` : 'Update the PRs?');
      },
    });
    if (result && !result.pushed && result.plan.push.length) say('Nothing pushed (the rebuilt branches wait; the next restack uses them).');
  } finally {
    gates.close();
  }
}

function describeRestackPlan(plan: RestackPlan): string {
  const status = { merged: '✓ merged', rebuilt: 'rebuilt', unchanged: 'unchanged' } as const;
  return [
    `Restack ${plan.slug} → ${plan.base}${plan.newlyMerged.length ? ` (merged since last time: ${plan.newlyMerged.join(', ')})` : ''}`,
    ...plan.pulls.map((pull, index) =>
      [
        `  ${index + 1}/${plan.pulls.length} ${pull.group}: ${pull.branch} — ${status[pull.status]}`,
        pull.status !== 'merged' ? ` ${pull.head.slice(0, 12)}` : '',
        pull.humanCommits ? `, ${plural(pull.humanCommits, 'human commit', 'human commits')} kept` : '',
        pull.resolved?.length ? `, conflicts resolved: ${pull.resolved.join(', ')}` : '',
        pull.becomesLowest ? `; now the lowest: base ${plan.base}, ready for review` : '',
      ].join(''),
    ),
    plan.push.length ? `  push     --force-with-lease: ${plan.push.join(', ')}` : '  push     nothing: the branches already sit on their bases',
  ].join('\n');
}

async function chooseReady(roots: string[], origin: FlowOrigin, gates: TtyGates): Promise<string | undefined> {
  const ready = roots
    .flatMap((root) => listFlows(root).flows)
    .filter((state) => state.status === 'done' && state.outcome === 'ready_to_publish' && path.resolve(state.origin.repoRoot) === origin.repoRoot);
  if (!ready.length) {
    say('No flows ready to publish in this repo (`agentic status` lists them all).');
    return undefined;
  }
  if (ready.length === 1) return ready[0]!.slug;
  if (!process.stdin.isTTY) throw new Error('Give a slug: agentic publish <slug> (list: agentic status).');
  const index = await gates.choose('Which flow to publish?', ready.map((state) => `${state.slug} · ${state.title}`));
  return index === undefined ? undefined : ready[index]!.slug;
}

async function clean(slug: string | undefined, options: CleanOptions): Promise<void> {
  const { loaded, roots } = context();
  const here = flowOrigin(loaded);
  if (!options.dryRun && !options.yes && !process.stdin.isTTY) throw new Error('No terminal to ask in; use --dry-run or --yes.');
  const gates = new TtyGates();
  try {
    if (!slug) return await cleanAll(roots, here, gates, options, say);
    const dir = flowDir(roots, slug);
    const { origin } = loadState(dir);
    // state.json lives where agents write; don't let it point the cleanup at another repo
    if (path.resolve(origin.repoRoot) !== here.repoRoot) {
      throw new Error(`Flow \`${slug}\` belongs to ${describeOrigin(origin)}, not to ${describeOrigin(here)}; run clean from that repo.`);
    }
    await cleanOne(dir, gates, options, say);
  } finally {
    gates.close();
  }
}

function describePlan(plan: PublishPlan): string {
  const { danger } = plan;
  return [
    `Publishing ${plan.slug}: "${plan.title}"`,
    `  branch   ${plan.branch} → ${plan.base} (${plural(plan.commits, 'commit', 'commits')}, +${danger.added} −${danger.deleted} in ${plural(danger.files, 'file', 'files')})`,
    `  forge    ${plan.forge === 'none' ? 'none: push only, plus a link to create the PR' : plan.forge}`,
    ...(plan.singlePrReason ? [`  PR       one for everything (${plan.singlePrReason})`] : []),
    ...(plan.stack ? describeStack(plan.stack) : []),
    `  door     ${danger.door === 'one-way' ? `one-way: ${danger.oneWay.map((file) => file.path).join(', ')}` : 'two-way'}`,
    `  size     ${linesText(plan.size.prod, plan.size.tests)} / ${plan.size.excluded} excluded (lines)`,
    ...(plan.size.over.length ? [`! over the soft publish.size threshold (${thresholdsText(plan.size.limits)}); harder for a reviewer to read carefully`] : []),
    `  PR body  ${plan.bodyFile}`,
    ...(plan.rebasedOnto !== undefined ? [`  target   moved onto origin/${plan.base} (+${plural(plan.rebasedOnto, 'target commit', 'target commits')} since the flow started), checks green`] : []),
    ...(plan.foreignCommits ? [`! commits the flow started on that origin/${plan.base} doesn't have: ${plan.foreignCommits}; they go into this PR`] : []),
    ...(plan.skippedGroups.length ? [`! groups ${plan.skippedGroups.join(', ')} are in other repos; publish doesn't push them yet`] : []),
  ].join('\n');
}

/** A PR per group, bottom first: branch, base, size and the door of its own diff, and a group that outgrew its estimate. */
function describeStack(stack: StackPullRequest[]): string[] {
  return [
    `  stack    ${pullRequests(stack.length)}, each on the previous one's branch; the lowest for review, the rest as drafts`,
    ...stack.flatMap((pull, index) => [
      `    ${index + 1}/${stack.length} ${pull.group}: ${pull.branch} → ${pull.base}${pull.draft ? ' (draft)' : ''}`,
      `        ${plural(pull.commits, 'commit', 'commits')}, ${linesText(pull.size.prod, pull.size.tests)} / ${pull.size.excluded} excluded${pull.size.over.length ? ' !' : ''}${pull.danger.door === 'one-way' ? `, one-way: ${pull.danger.oneWay.map((file) => file.path).join(', ')}` : ''}, body ${pull.bodyFile}`,
      ...(pull.sizeWarning ? [`      ! ${pull.sizeWarning}`] : []),
    ]),
  ];
}

function pullRequests(count: number): string {
  return plural(count, 'PR', 'PRs');
}

/** `root` takes new flows; `roots` also has the legacy one inside the repo, for flows started before. */
function context(overrides?: FlowState['overrides']): { loaded: LoadedConfig; root: string; roots: string[] } {
  const loaded = loadConfig({ cwd: process.cwd(), flow: overrides?.autonomy ? { autonomy: overrides.autonomy } : undefined });
  return { loaded, root: workRoot(loaded, process.cwd()), roots: workRoots(loaded, process.cwd()) };
}

function flowOrigin(loaded: LoadedConfig): FlowOrigin {
  return { repoRoot: repoRootOf(loaded), ...(loaded.workspaceRoot && { workspaceRoot: path.resolve(loaded.workspaceRoot) }) };
}

function describeOrigin(origin: FlowOrigin): string {
  return origin.workspaceRoot ? `${origin.repoRoot} (workspace ${origin.workspaceRoot})` : origin.repoRoot;
}

function flowDir(roots: string[], slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`Invalid slug \`${slug}\``);
  const dir = roots.map((root) => path.join(root, slug)).find((candidate) => fs.existsSync(path.join(candidate, 'state.json')));
  if (!dir) throw new Error(`No flow \`${slug}\` in ${roots.join(' or ')}`);
  return dir;
}

/**
 * The fake's tests are a text file, so the repo's real checks pass on the base code and the red gate would stop
 * every `--fake` run. A demo skips the stage instead.
 */
function withoutTestsFirst(config: AgenticConfig): AgenticConfig {
  if (!writeTestsEnabled(config)) return config;
  say('--fake: write-tests stage skipped (the fake writes no tests that are red on the base).');
  return { ...config, stages: { ...config.stages, 'write-tests': { ...config.stages['write-tests'], enabled: false } } };
}

/** The client's version: a stopped machine still counts as installed. */
function podmanVersion(): Promise<string | undefined> {
  return new Promise((resolve) => execFile('podman', ['--version'], { timeout: 8000 }, (error, stdout) => resolve(error ? undefined : /(\d+\.\d+\.\d+)/.exec(stdout)?.[1])));
}

/** The fake harness plays its replies in its own in-process sandbox. */
function sessionRuntime(fake: boolean | undefined, loaded: LoadedConfig): Pick<FlowContext, 'harnesses' | 'sandbox'> {
  if (fake) {
    const { claude, codex, sandbox } = fakeRegistry();
    return { harnesses: { claude, codex }, sandbox };
  }
  const { catalog, config } = loaded;
  return {
    harnesses: cliRegistry(catalog),
    sandbox: createSandbox(config.sandbox, repoRootOf(loaded)),
  };
}

/** `resume`, and `pick` of a ticket whose unfinished flow the human chose to continue. */
async function resumeFlow(slug: string, options: RunOptions, gates?: TtyGates): Promise<void> {
  const base = context();
  const dir = flowDir(base.roots, slug);
  const state = loadState(dir);
  if (options.autonomy) {
    state.overrides = { ...state.overrides, autonomy: options.autonomy };
    saveState(dir, state);
  } else if (state.overrides?.autonomy) {
    // state.json sits where agents write: a remembered preset may add gates, never remove them
    const remembered = activeGates({ autonomy: state.overrides.autonomy, gates: base.loaded.config.gates });
    const dropped = [...activeGates(base.loaded.config)].filter((gate) => !remembered.has(gate));
    if (dropped.length) {
      say(`The saved preset \`${state.overrides.autonomy}\` drops gates ${dropped.join(', ')}; ignoring it. To use it: agentic resume ${slug} --autonomy ${state.overrides.autonomy}`);
      state.overrides = { ...state.overrides, autonomy: undefined };
    }
  }
  const { loaded } = context(state.overrides);
  // state.json lives where agents write; don't let it redirect work to another directory
  const here = flowOrigin(loaded);
  if (path.resolve(state.origin.repoRoot) !== here.repoRoot || (state.origin.workspaceRoot ?? '') !== (here.workspaceRoot ?? '')) {
    throw new Error(`Flow \`${slug}\` belongs to ${describeOrigin(state.origin)}, not to ${describeOrigin(here)}; run resume from that repo.`);
  }
  preflight(loaded);
  await execute(dir, loaded, options, gates);
}

/** What has to hold before a flow starts or resumes: `review.checks` set, rule ids unambiguous. */
/** The flow's gates need the same terminal later, so a paste ends with a `.` line, not with EOF. */
async function paste(gates: TtyGates, what: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${what}: no terminal; give the text as an argument or a file.`);
  const text = await gates.readText(`${what}, then a line with just a dot \`${PASTE_END}\`:`);
  if (text === undefined) throw new Error(`${what}: empty text or end of input before \`${PASTE_END}\`; nothing started.`);
  return text;
}

/**
 * The PR's target, fetched before the flow starts: the first groups start at its tip on `origin`, not at the local
 * HEAD. Says so when HEAD has commits the target doesn't — they won't be in the flow.
 */
function startTarget(loaded: LoadedConfig, base: string | undefined): FlowTarget | undefined {
  const repo = flowOrigin(loaded).repoRoot;
  const target = flowTarget(repo, base);
  if (!target) return undefined;
  say(`PR target: origin/${target.branch} (${target.commit.slice(0, 12)}); the flow starts from it.`);
  const local = hostGit(repo, ['rev-list', '--count', `${target.commit}..HEAD`]);
  if (local !== '0') say(`! HEAD has ${plural(Number(local), 'commit', 'commits')} not on origin/${target.branch}; they won't be in the flow (another target: --base <branch>).`);
  return target;
}

function preflight(loaded: LoadedConfig): void {
  checkCommands(loaded.config.review);
  assertUniqueRuleIds(loaded.config, repoRootOf(loaded));
}

async function execute(workDir: string, loaded: LoadedConfig, options: RunOptions, gates = new TtyGates()): Promise<void> {
  for (const warning of loaded.warnings) say(`! ${warning}`);
  const stale = staleBuild();
  if (stale) {
    const { detail, fix } = staleBuildWarning(stale);
    say(`! ${detail} (${fix})`);
  }
  const runtime = sessionRuntime(options.fake, loaded);
  const config = options.fake ? withoutTestsFirst(loaded.config) : loaded.config;
  const live = new LiveLine();
  const state = await (async () => {
    const trusted = runtime.sandbox.isolated || (await confirmChecks(loaded, gates));
    return runFlow({
      workDir,
      config,
      catalog: loaded.catalog,
      profile: loaded.profile,
      ...runtime,
      // a gate's menu has the terminal to itself
      gates: { decide: (request) => live.aside(() => gates.decide(request)), confirm: (question) => live.aside(() => gates.confirm(question)) },
      checksTrusted: trusted,
      log: (text) => live.say(sanitize(text)),
      progress: (id, line) => live.progress(id, line && sanitize(line)),
      onEvent: notifier(loaded.config.notify),
      ...(!options.fake && { probe: probeNetwork }),
    });
  })().finally(() => gates.close());
  say(describeState(state));
  if (state.status === 'paused') say(`To resume: agentic resume ${state.slug}`);
  if ((state.status === 'aborted' || state.status === 'failed') && process.stdin.isTTY) {
    const prompt = new TtyGates();
    try {
      await offerAfterEnd(workDir, state, prompt, say);
    } finally {
      prompt.close();
    }
  }
}

/**
 * Outside a container `review.checks` run on the host — code the agent may change (`build.gradle`, `package.json`).
 * The first flow in a repo asks; the answer holds until the command list changes. `--autonomy` doesn't skip it.
 */
async function confirmChecks(loaded: LoadedConfig, gates: TtyGates): Promise<boolean> {
  const commands = hostCommands(loaded.config.review);
  if (!commands.length) return true;
  const repoRoot = repoRootOf(loaded);
  if (checksTrusted(loaded.globalDir, repoRoot, commands)) return true;
  say(
    [
      `\`review.checks\`${loaded.config.review.compile ? ' and `review.compile`' : ''} in ${repoRoot} will run on this computer, with your permissions and full network:`,
      ...commands.map((command) => `  $ ${command}`),
      "They run build scripts from the clone that the agent can change (e.g. build.gradle, package.json): the agent's code on your host.",
      'The orchestrator runs them after each session, and the agent itself during a session (`run-checks`, the only command outside the sandbox).',
      '`sandbox.mode: container` gives full isolation; then no consent is needed.',
      `The consent covers this repo and this command list (saved in ${trustFile(loaded.globalDir)}).`,
    ].join('\n'),
  );
  if (!(await gates.confirm('Allow?'))) {
    say('Without consent the flow stops before the first `checks` run.');
    return false;
  }
  trustChecks(loaded.globalDir, repoRoot, commands);
  return true;
}

/** `dir` given: a `running` flow whose process is gone is shown as interrupted. */
/** One line of the `resume` list: slug, where it stopped, when, and why. */
function describeUnfinished(state: FlowState): string {
  const when = String(state.updated_at).slice(0, 16).replace('T', ' ');
  const why = state.paused ? ` · ${state.paused.reason}${state.paused.message ? `: ${state.paused.message.replace(/\/\S*\//g, '').replace(/\s+/g, ' ').slice(0, 100)}` : ''}` : ' · interrupted';
  return `${state.slug} · stage ${state.stage} · ${when}${why}`;
}

function describeState(state: FlowState, dir?: string): string {
  const status = dir && state.status === 'running' && !flowRunning(dir) ? 'interrupted (agentic resume)' : state.status;
  const pause = state.paused ? ` — ${state.paused.reason}${state.paused.gate ? ` (${state.paused.gate})` : ''}: ${state.paused.message ?? ''}` : '';
  return `${state.slug}: ${status}, stage ${state.stage}${state.outcome ? `, outcome ${state.outcome}` : ''}${pause}`;
}

function printFlows(root: string, roots: string[]): void {
  const listed = roots.map((dir) => ({ dir, ...listFlows(dir) }));
  const flows = listed
    .flatMap(({ dir, flows: states }) => states.map((state) => ({ state, dir: path.join(dir, state.slug), legacy: dir !== root })))
    .sort((left, right) => String(right.state.updated_at).localeCompare(String(left.state.updated_at)));
  const broken = listed.flatMap((entry) => entry.broken);
  if (!flows.length && !broken.length) {
    say(`No flows in ${root}. Start with \`agentic new "<idea>"\`.`);
    return;
  }
  for (const { state, dir, legacy } of flows) {
    say(`${String(state.updated_at).slice(0, 16).replace('T', ' ')}  ${describeState(state, dir)}${legacy ? ` [${path.dirname(dir)}]` : ''}`);
  }
  for (const brokenEntry of broken) say(`! ${brokenEntry}`);
}

function printFlow(dir: string): void {
  const state = loadState(dir, (warning) => say(`! ${warning}`));
  say(describeState(state, dir));
  say(`  created ${state.created_at}, directory ${dir}${state.overrides?.autonomy ? `, autonomy ${state.overrides.autonomy}` : ''}`);
  for (const stage of STAGES) {
    const stageState = state.stages[stage];
    say(`  ${stage.padEnd(13)} ${stageState.status}${stageState.gate ? ' (gate ✓)' : ''}`);
    if (stage === 'implement') {
      for (const [id, group] of Object.entries(state.groups)) {
        const tasks = Object.entries(group.tasks).map(([taskId, taskStatus]) => `${taskId}:${taskStatus}`).join(' ');
        const review = group.review ? `, review: ${reviewSummary(group)}` : '';
        const stop = group.blocked ?? group.failure;
        const stopNote = stop ? `, ${group.blocked ? 'paused' : 'failed'}: ${stop.reason}${stop.message ? ` — ${stop.message}` : ''}` : '';
        const size = group.size ? `, ${group.size.warning ? `⚠ ${group.size.warning}` : linesText(group.size.prod, group.size.tests)}` : '';
        say(`    ${id.padEnd(11)} ${group.status} [${tasks}]${review}${size}${group.branch ? `, branch ${group.branch}` : ''}${stopNote}`);
      }
    }
    const finalReview = state.final_review;
    if (stage === 'final-review' && finalReview?.review) {
      say(`    review: ${reviewSummary(finalReview)}${finalReview.gate ? ' (gate ✓)' : ''}${finalReview.branch ? `, branch ${finalReview.branch}` : ''}`);
    }
  }
  if (state.published?.stack) {
    say(`  published ${state.published.at}: stack of ${pullRequests(state.published.stack.length)} into ${state.published.base}`);
    for (const pull of state.published.stack) say(`    ${pull.group}: ${pull.branch} → ${pull.base}${pull.url ? `, ${pull.url}` : ''}${pull.merged ? ' ✓ merged' : ''}`);
    if (state.restack) say(`  restack in progress (${plural(state.restack.branches.length, 'branch', 'branches')}); finish it: agentic restack ${state.slug}`);
  } else if (state.published) say(`  published ${state.published.at}: ${state.published.branch} → ${state.published.base}${state.published.url ? `, ${state.published.url}` : ''}`);
  const usage = summarizeUsage(dir);
  say(`  usage: ${usage.sessions} sessions, ${usage.tokens} tokens, ${usage.minutes.toFixed(1)} min${usage.costUsd ? `, $${usage.costUsd.toFixed(2)}` : ''} (details: agentic usage ${state.slug})`);
}
