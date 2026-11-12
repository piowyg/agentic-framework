import type { ContainerEngine } from '../config/types.js';
import { CACHE_VOLUME_PREFIX, PID_LABEL, SANDBOX_LABEL } from './container.js';
import { engineOutput, engineRun } from './engine.js';

export interface Leftovers {
  containers: string[];
  networks: string[];
}

/**
 * Containers and session networks whose `agentic` process is gone: a crash or a SIGKILL skipped the sandbox's
 * own cleanup. Anything of a live process belongs to a running flow and is left alone; the shared
 * `agentic-egress` network carries no pid and stays.
 */
export async function findLeftovers(engine: ContainerEngine, alive: (pid: number) => boolean = processAlive): Promise<Leftovers> {
  const orphaned = (pid: string) => !pid || !alive(Number(pid));
  const containerIds = lines(await engineOutput(engine, ['ps', '--all', '--quiet', `--filter=label=${SANDBOX_LABEL}`]));
  const containers = containerIds.length
    ? labelled(await engineOutput(engine, ['container', 'inspect', '--format', `{{.Name}} {{ index .Config.Labels "${PID_LABEL}" }}`, ...containerIds]))
    : [];
  const networkIds = lines(await engineOutput(engine, ['network', 'ls', '--quiet', `--filter=label=${SANDBOX_LABEL}`]));
  const networks = networkIds.length
    ? labelled(await engineOutput(engine, ['network', 'inspect', '--format', `{{.Name}} {{ index .Labels "${PID_LABEL}" }}`, ...networkIds]))
    : [];
  return {
    containers: containers.filter(([, pid]) => orphaned(pid)).map(([name]) => name.replace(/^\//, '')),
    // a network without a pid is the shared egress network
    networks: networks.filter(([, pid]) => pid && orphaned(pid)).map(([name]) => name),
  };
}

/** Containers first, with their anonymous volumes (an inner Podman's store): a network with a container attached can't go. */
export async function removeLeftovers(engine: ContainerEngine, leftovers: Leftovers): Promise<void> {
  if (leftovers.containers.length) await engineOutput(engine, ['rm', '--force', '--volumes', ...leftovers.containers]);
  for (const network of leftovers.networks) await engineOutput(engine, ['network', 'rm', network]);
}

/** The dependency caches' volumes (`sandbox.caches`), for `clean --caches`. */
export async function cacheVolumes(engine: ContainerEngine): Promise<string[]> {
  return lines(await engineOutput(engine, ['volume', 'ls', '--quiet'])).filter((name) => name.startsWith(CACHE_VOLUME_PREFIX));
}

export async function removeVolumes(engine: ContainerEngine, volumes: string[]): Promise<boolean> {
  return !volumes.length || (await engineRun(engine, ['volume', 'rm', ...volumes])).exitCode === 0;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, someone else's
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** `name pid` lines; `<no value>` is how a template prints a missing label. */
function labelled(text: string): Array<[string, string]> {
  return lines(text).map((line) => {
    const [name = '', pid = ''] = line.split(' ');
    return [name, pid === '<no value>' ? '' : pid];
  });
}
