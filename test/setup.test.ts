import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PodmanMachine } from '../src/sandbox/podman-machine.js';
import { runSetup, type SetupDeps } from '../src/setup.js';
import { tmpDir } from './helpers.js';

// Setup offers a dictation app once, with consent.

function fakeSetup(overrides: Partial<SetupDeps> & { answers?: boolean[]; installs?: boolean } = {}) {
  const { answers = [], installs = true, ...rest } = overrides;
  const questions: string[] = [];
  const runs: string[] = [];
  const output: string[] = [];
  const deps: SetupDeps = {
    dictationApp: async () => undefined,
    platform: 'darwin',
    hasBrew: async () => true,
    run: async (command, args) => {
      runs.push([command, ...args].join(' '));
      return installs;
    },
    confirm: async (question) => {
      questions.push(question);
      return answers.shift() ?? false;
    },
    interactive: true,
    say: (text) => output.push(text),
    today: () => '2026-10-10',
    ...rest,
  };
  return { deps, questions, runs, output };
}

describe('setup: dictation', () => {
  const home = () => tmpDir();
  const env = (dir: string) => ({ AGENTIC_HOME: dir });
  const state = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8')) as unknown;

  it('installs Handy with brew after a yes and remembers it', async () => {
    const dir = home();
    const { deps, questions, runs, output } = fakeSetup({ answers: [true] });
    await runSetup({ env: env(dir) }, deps);
    expect(questions).toEqual([expect.stringContaining('brew install --cask handy')]);
    expect(runs).toEqual(['brew install --cask handy']);
    expect(output.at(-1)).toMatch(/Handy installed.*Accessibility/);
    expect(state(dir)).toEqual({ dictation: { answer: 'installed', on: '2026-10-10' } });
  });

  it('asks once: a no is remembered and the next setup only points to the dictation guide', async () => {
    const dir = home();
    const first = fakeSetup({ answers: [false] });
    await runSetup({ env: env(dir) }, first.deps);
    expect(first.runs).toEqual([]);
    expect(state(dir)).toEqual({ dictation: { answer: 'declined', on: '2026-10-10' } });

    const second = fakeSetup({ answers: [true] });
    await runSetup({ env: env(dir) }, second.deps);
    expect(second.questions).toEqual([]);
    expect(second.runs).toEqual([]);
    expect(second.output).toEqual([expect.stringMatching(/already offered \(2026-10-10\)/)]);
  });

  it('a failed install is not remembered, so the next setup offers it again', async () => {
    const dir = home();
    const failed = fakeSetup({ answers: [true], installs: false });
    await runSetup({ env: env(dir) }, failed.deps);
    expect(failed.output.at(-1)).toMatch(/install failed/);
    expect(fs.existsSync(path.join(dir, 'setup.json'))).toBe(false);

    const again = fakeSetup({ answers: [false] });
    await runSetup({ env: env(dir) }, again.deps);
    expect(again.questions).toHaveLength(1);
  });

  it('asks nothing when a dictation app is already installed', async () => {
    const dir = home();
    const { deps, questions, output } = fakeSetup({ dictationApp: async () => 'superwhisper' });
    await runSetup({ env: env(dir) }, deps);
    expect(questions).toEqual([]);
    expect(output).toEqual(['✓ dictation: superwhisper']);
    expect(fs.existsSync(path.join(dir, 'setup.json'))).toBe(false);
  });

  it('without a terminal, brew or macOS it only suggests, and records nothing', async () => {
    for (const overrides of [{ interactive: false }, { hasBrew: async () => false }, { platform: 'linux' as const }]) {
      const dir = home();
      const { deps, questions, runs, output } = fakeSetup({ ...overrides, answers: [true] });
      await runSetup({ env: env(dir) }, deps);
      expect(questions).toEqual([]);
      expect(runs).toEqual([]);
      expect(output).toEqual([expect.stringMatching(/handy/i)]);
      expect(fs.existsSync(path.join(dir, 'setup.json'))).toBe(false);
    }
  });
});

describe('setup: podman', () => {
  const container = { mode: 'container' as const, engine: 'podman' as const };
  const env = (dir: string) => ({ AGENTIC_HOME: dir });
  const podman = (state: { version?: string; machines?: PodmanMachine[] }) => ({
    version: async () => state.version,
    machines: async () => state.machines,
  });

  it('installs with brew, then creates and starts the machine, each after a yes; dictation comes after', async () => {
    const dir = tmpDir();
    const installed: { version?: string; machines?: PodmanMachine[] } = { machines: [] };
    const setup = fakeSetup({ answers: [true, true, false], podman: podman(installed) });
    setup.deps.run = async (command, args) => {
      setup.runs.push([command, ...args].join(' '));
      if (args[0] === 'install') installed.version = '5.6.1';
      return true;
    };
    await runSetup({ env: env(dir), sandbox: container }, setup.deps);
    expect(setup.questions).toEqual([
      'Install Podman (`brew install podman`)?',
      expect.stringContaining('podman machine init --now --memory 4096'),
      expect.stringContaining('brew install --cask handy'),
    ]);
    expect(setup.runs).toEqual(['brew install podman', 'podman machine init --now --memory 4096']);
    expect(setup.output).toContain('✓ podman 5.6.1 installed; session image: `agentic sandbox build`');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8'))).toEqual(expect.objectContaining({ podman: { answer: 'installed', on: '2026-10-10' } }));
  });

  it('a stopped machine is started after a yes; a running one asks nothing', async () => {
    const stopped = fakeSetup({ answers: [true], podman: podman({ version: '5.6.1', machines: [{ name: 'podman-machine-default', running: false }] }), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: container }, stopped.deps);
    expect(stopped.runs).toEqual(['podman machine start podman-machine-default']);

    const running = fakeSetup({ podman: podman({ version: '5.6.1', machines: [{ name: 'm', running: true }] }), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: container }, running.deps);
    expect(running.questions).toEqual([]);
    expect(running.output[0]).toBe('✓ podman 5.6.1; session image: `agentic sandbox build`');
  });

  it('a machine under 4 GB is resized after a yes (a restart); a no leaves it, with the commands', async () => {
    const small = { name: 'm', running: true, memoryMb: 2048 };
    const resized = fakeSetup({ answers: [true], podman: podman({ version: '5.6.1', machines: [small] }), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: container }, resized.deps);
    expect(resized.questions).toEqual([expect.stringMatching(/has 2048 MB RAM.*Raise it to 4096 MB/)]);
    expect(resized.runs).toEqual(['podman machine stop m', 'podman machine set --memory 4096 m', 'podman machine start m']);

    const kept = fakeSetup({ answers: [false], podman: podman({ version: '5.6.1', machines: [small] }), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: container }, kept.deps);
    expect(kept.runs).toEqual([]);
    expect(kept.output[0]).toBe('i podman: machine m has 2048 MB RAM, 4096 recommended; `podman machine stop m && podman machine set --memory 4096 m && podman machine start m` before the first flow');
    // still running, so still usable
    expect(kept.output[1]).toBe('✓ podman 5.6.1; session image: `agentic sandbox build`');
  });

  it('a resize that fails after the stop leaves no ✓: the machine may be down', async () => {
    const failed = fakeSetup({ answers: [true], podman: podman({ version: '5.6.1', machines: [{ name: 'm', running: true, memoryMb: 2048 }] }), dictationApp: async () => 'Handy' });
    failed.deps.run = async (command, args) => {
      failed.runs.push([command, ...args].join(' '));
      return args[1] !== 'set';
    };
    await runSetup({ env: env(tmpDir()), sandbox: container }, failed.deps);
    expect(failed.runs).toEqual(['podman machine stop m', 'podman machine set --memory 4096 m']);
    expect(failed.output).toContain('✗ podman: `podman machine set --memory 4096 m` failed');
    expect(failed.output.filter((line) => line.startsWith('✓ podman'))).toEqual([]);
  });

  it('a no to the install is remembered; docker or mode none skip the step', async () => {
    const dir = tmpDir();
    const first = fakeSetup({ answers: [false], podman: podman({}), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(dir), sandbox: container }, first.deps);
    const second = fakeSetup({ answers: [true], podman: podman({}), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(dir), sandbox: container }, second.deps);
    expect(second.questions).toEqual([]);
    expect(second.output[0]).toMatch(/already offered \(2026-10-10\)/);

    const docker = fakeSetup({ podman: podman({}), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: { mode: 'container', engine: 'docker' } }, docker.deps);
    expect(docker.questions).toEqual([]);
    expect(docker.output[0]).toBe('i podman: skipped (sandbox.engine: docker)');
  });

  it('outside macOS: only the docs link', async () => {
    const linux = fakeSetup({ platform: 'linux', podman: podman({}), dictationApp: async () => 'Handy' });
    await runSetup({ env: env(tmpDir()), sandbox: container }, linux.deps);
    expect(linux.questions).toEqual([]);
    expect(linux.output[0]).toMatch(/podman\.io\/docs\/installation/);
  });
});
