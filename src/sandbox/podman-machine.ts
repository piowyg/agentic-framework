import { execFile } from 'node:child_process';

/** Podman's default 2 GB gets a Gradle daemon with its test JVM killed by the VM's OOM killer. */
export const MACHINE_MEMORY_MB = 4096;

/** On macOS Podman runs containers in a Linux VM. */
export interface PodmanMachine {
  name: string;
  running: boolean;
  /** The VM's RAM; undefined when Podman didn't report it. */
  memoryMb?: number;
}

/** The arguments of one `podman` command. */
export type PodmanArgs = string[];

/** Creates the machine with enough memory and starts it. */
export const INIT_STEPS: PodmanArgs[] = [['machine', 'init', '--now', '--memory', String(MACHINE_MEMORY_MB)]];

export function isUndersized(machine: PodmanMachine): boolean {
  return machine.memoryMb !== undefined && machine.memoryMb < MACHINE_MEMORY_MB;
}

/** Podman sets the memory of a stopped machine only. */
export function resizeSteps(machine: PodmanMachine): PodmanArgs[] {
  return [...(machine.running ? [['machine', 'stop', machine.name]] : []), ['machine', 'set', '--memory', String(MACHINE_MEMORY_MB), machine.name], ['machine', 'start', machine.name]];
}

/** The steps as one line to paste into a shell. */
export function shellLine(steps: PodmanArgs[]): string {
  return steps.map((args) => `podman ${args.join(' ')}`).join(' && ');
}

/** `podman machine list`; undefined when it fails. `Memory` is in bytes, as a string (Podman 5). */
export function podmanMachines(): Promise<PodmanMachine[] | undefined> {
  return new Promise((resolve) =>
    execFile('podman', ['machine', 'list', '--format', 'json'], { timeout: 15_000 }, (error, stdout) => {
      try {
        const machines = error ? undefined : (JSON.parse(stdout) as Array<{ Name: string; Running: boolean; Memory?: string | number }>);
        resolve(
          machines?.map((machine) => {
            const memoryMb = Math.round(Number(machine.Memory) / 1024 / 1024);
            return { name: machine.Name, running: machine.Running, ...(memoryMb > 0 && { memoryMb }) };
          }),
        );
      } catch {
        resolve(undefined);
      }
    }),
  );
}
