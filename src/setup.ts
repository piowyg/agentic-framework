// `agentic setup`: installs and prepares what the framework suggests, each step only with consent.
// TODO: `--role swe|pm|qa`.

import fs from 'node:fs';
import path from 'node:path';
import { globalDir } from './config/load.js';
import type { AgenticConfig } from './config/types.js';
import { INIT_STEPS, isUndersized, MACHINE_MEMORY_MB, resizeSteps, shellLine, type PodmanArgs, type PodmanMachine } from './sandbox/podman-machine.js';

export interface SetupDeps {
  /** The name of an installed dictation app; undefined when none is found. */
  dictationApp: () => Promise<string | undefined>;
  platform: NodeJS.Platform;
  hasBrew: () => Promise<boolean>;
  /** Runs the command in the user's terminal; true when it exits with 0. */
  run: (command: string, args: string[]) => Promise<boolean>;
  confirm: (question: string) => Promise<boolean>;
  /** False without a terminal: setup then asks nothing and records nothing. */
  interactive: boolean;
  say: (text: string) => void;
  today: () => string;
  /** Absent: the Podman step is skipped. */
  podman?: PodmanDeps;
}

export interface PodmanDeps {
  /** Undefined when `podman` isn't installed. */
  version: () => Promise<string | undefined>;
  /** `podman machine list` (macOS); undefined when it fails. */
  machines: () => Promise<PodmanMachine[] | undefined>;
}

type SandboxChoice = Pick<AgenticConfig['sandbox'], 'mode' | 'engine'>;
/** A yes or a no to an offer; undefined when nothing was asked or it failed (setup asks again next time). */
type OfferAnswer = 'installed' | 'declined' | undefined;

/** Offers already answered, so setup asks each question once (`<AGENTIC_HOME>/setup.json`). */
interface SetupState {
  dictation?: { answer: NonNullable<OfferAnswer>; on: string };
  podman?: { answer: NonNullable<OfferAnswer>; on: string };
}

const HANDY_URL = 'https://handy.computer';

export async function runSetup(options: { env?: NodeJS.ProcessEnv; sandbox?: SandboxChoice }, deps: SetupDeps): Promise<void> {
  const file = path.join(globalDir(options.env), 'setup.json');
  let state = readState(file);
  if (options.sandbox && deps.podman) {
    const podman = await preparePodman(state, options.sandbox, deps, deps.podman);
    if (podman) writeState(file, (state = { ...state, podman: { answer: podman, on: deps.today() } }));
  }
  const dictation = await offerDictation(state, deps);
  if (dictation) writeState(file, { ...state, dictation: { answer: dictation, on: deps.today() } });
}

const PODMAN_DOCS = 'https://podman.io/docs/installation';

/**
 * The default engine: installed with brew on macOS, and its Linux VM created and started.
 * Each step asks first; a no to the install is remembered, the machine is offered every time it isn't running.
 */
async function preparePodman(
  state: SetupState,
  sandbox: SandboxChoice,
  deps: SetupDeps,
  podman: PodmanDeps,
): Promise<OfferAnswer> {
  if (sandbox.mode !== 'container' || sandbox.engine !== 'podman') {
    deps.say(`i podman: skipped (sandbox.${sandbox.mode === 'container' ? `engine: ${sandbox.engine}` : 'mode: none'})`);
    return undefined;
  }
  let installed: 'installed' | undefined;
  let version = await podman.version();
  if (!version) {
    if (state.podman?.answer === 'declined') {
      deps.say(`i podman: already offered (${state.podman.on}); \`brew install podman\` or ${PODMAN_DOCS}; without it \`sandbox.mode: none\``);
      return undefined;
    }
    if (deps.platform !== 'darwin' || !(await deps.hasBrew())) {
      deps.say(`i podman: agent sessions run in Podman containers; install: ${PODMAN_DOCS}`);
      return undefined;
    }
    if (!deps.interactive) {
      deps.say('i podman: skipped without a terminal; `brew install podman`');
      return undefined;
    }
    deps.say('Podman: each agent session runs in a throwaway container (rootless, no daemon, no Docker Desktop licence).');
    if (!(await deps.confirm('Install Podman (`brew install podman`)?'))) {
      deps.say("i podman: skipped; setup won't ask again; without Podman set `sandbox.mode: none` or `sandbox.engine: docker`");
      return 'declined';
    }
    if (!(await deps.run('brew', ['install', 'podman'])) || !(version = await podman.version())) {
      deps.say(`✗ podman: install failed; try \`brew install podman\` by hand or ${PODMAN_DOCS}`);
      return undefined;
    }
    installed = 'installed';
  }
  if (deps.platform === 'darwin' && !(await podmanMachine(deps, podman))) return installed;
  deps.say(`✓ podman ${version}${installed ? ' installed' : ''}; session image: \`agentic sandbox build\``);
  return installed;
}

/**
 * On macOS containers run in a Linux VM: created (`init --now` also starts it) or started, and one with less than
 * `MACHINE_MEMORY_MB` resized (a restart). True when one runs.
 */
async function podmanMachine(deps: SetupDeps, podman: PodmanDeps): Promise<boolean> {
  const machines = await podman.machines();
  const machine = machines?.find((candidate) => candidate.running) ?? machines?.[0];
  if (!machine) {
    const question = `Create and start a Podman machine (\`${shellLine(INIT_STEPS)}\`; a Linux virtual machine, a few GB of disk, ${MACHINE_MEMORY_MB / 1024} GB RAM)?`;
    return (await machineSteps(deps, question, 'the machine is not running', INIT_STEPS)) === 'done';
  }
  const { name } = machine;
  if (isUndersized(machine)) {
    const question = `Podman machine ${name} has ${machine.memoryMb} MB RAM; Gradle with tests in a container will run out of memory. Raise it to ${MACHINE_MEMORY_MB} MB (restarts the machine)?`;
    const resized = await machineSteps(deps, question, `machine ${name} has ${machine.memoryMb} MB RAM, ${MACHINE_MEMORY_MB} recommended`, resizeSteps(machine));
    // a failed step may come after the stop: the machine's state from before is no longer known
    if (resized !== 'declined') return resized === 'done';
  }
  if (machine.running) return true;
  return (await machineSteps(deps, `Start Podman machine ${name} (\`podman machine start\`)?`, 'the machine is not running', [['machine', 'start', name]])) === 'done';
}

/** `podman` commands run one after another after a yes; without one, `why` and the commands as a hint. */
async function machineSteps(deps: SetupDeps, question: string, why: string, steps: PodmanArgs[]): Promise<'done' | 'declined' | 'failed'> {
  if (!deps.interactive || !(await deps.confirm(question))) {
    deps.say(`i podman: ${why}; \`${shellLine(steps)}\` before the first flow`);
    return 'declined';
  }
  for (const args of steps) {
    if (!(await deps.run('podman', args))) {
      deps.say(`✗ podman: \`${shellLine([args])}\` failed`);
      return 'failed';
    }
  }
  return 'done';
}

/** Speaking grill answers is faster than typing them; the offer comes once and a no is remembered. */
async function offerDictation(state: SetupState, deps: SetupDeps): Promise<OfferAnswer> {
  const found = await deps.dictationApp();
  if (found) {
    deps.say(`✓ dictation: ${found}`);
    return undefined;
  }
  if (state.dictation) {
    deps.say(`i dictation: already offered (${state.dictation.on}); install by hand: docs/en/guides/dictation.md`);
    return undefined;
  }
  if (deps.platform !== 'darwin' || !(await deps.hasBrew())) {
    deps.say(`i dictation: you answer grills faster by speaking than by typing; Handy: ${HANDY_URL} (docs/en/guides/dictation.md)`);
    return undefined;
  }
  if (!deps.interactive) {
    deps.say('i dictation: skipped without a terminal; `brew install --cask handy` (docs/en/guides/dictation.md)');
    return undefined;
  }
  deps.say('Dictation: you answer grills faster by speaking than by typing. Handy is free and runs locally (offline).');
  if (!(await deps.confirm('Install Handy (`brew install --cask handy`)?'))) {
    deps.say("i dictation: skipped; setup won't ask again; `agentic doctor` still suggests it");
    return 'declined';
  }
  if (!(await deps.run('brew', ['install', '--cask', 'handy']))) {
    deps.say(`✗ dictation: install failed; try \`brew install --cask handy\` by hand or ${HANDY_URL}`);
    return undefined;
  }
  deps.say(
    '✓ dictation: Handy installed. On first launch allow the microphone and Accessibility, pick a model and set a push-to-talk shortcut (docs/en/guides/dictation.md).',
  );
  return 'installed';
}

function readState(file: string): SetupState {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SetupState;
  } catch {
    return {};
  }
}

function writeState(file: string, state: SetupState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
