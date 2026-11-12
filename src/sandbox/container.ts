import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CacheName, ContainerEngine } from '../config/types.js';
import type { HarnessCommand, ProcessResult } from '../harness/types.js';
import { EGRESS_SCRIPT_NAME } from './image.js';
import { engineRun } from './engine.js';
import { runProcess } from './process.js';
import type { AgentView, ExecOptions, Sandbox, SessionWorkspace } from './types.js';

export interface ContainerSettings {
  engine: ContainerEngine;
  image: string;
  /** The image the egress proxy runs in; `image` when absent. */
  baseImage?: string;
  /** The stack's hosts (`image.ts`), allowed on top of the session's list whenever it has network. */
  hosts?: readonly string[];
  caches?: readonly CacheName[];
  /** `sandbox.containers`: a rootless Podman inside the session, for Testcontainers and the like. */
  containers?: boolean;
}

/** What a rootless Podman inside the container needs instead of `--cap-drop=ALL` (no SYS_ADMIN, no NET_ADMIN). */
const CONTAINERS_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETFCAP', 'SETGID', 'SETUID', 'SYS_CHROOT'];
/** Starts the inner Podman's API socket and points Docker clients at it (`sandbox/base/containers-entry.sh`). */
/** Gives the host uid a passwd entry with /home/agent as its home, before any session command (`home-entry.sh`). */
const HOME_ENTRY = '/usr/local/lib/agentic/home-entry.sh';
const CONTAINERS_ENTRY = '/usr/local/lib/agentic/containers-entry.sh';
/** Docker Hub, where images like `postgres:16` come from; allowed whenever a session with network runs containers. */
export const REGISTRY_HOSTS = ['registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com', 'production.cloudfront.docker.com'];

/** Fixed paths inside the container, so prompts and skills read the same everywhere. */
export const CONTAINER_PATHS = { code: '/workspace', out: '/out', context: '/context', home: '/home/agent' } as const;
/** The inner Podman's images and containers (`sandbox.containers`). */
const CONTAINERS_STORE = `${CONTAINER_PATHS.home}/.local/share/containers`;

/** The outside network every egress proxy joins; sessions never do. */
export const EGRESS_NETWORK = 'agentic-egress';
/** The proxy's name on a session's internal network. */
const EGRESS_HOST = 'egress';
const EGRESS_PORT = 3128;
/** Where the base image keeps the proxy (`sandbox/base/Dockerfile`). */
const EGRESS_IN_IMAGE = `/usr/local/lib/agentic/${EGRESS_SCRIPT_NAME}`;
const EGRESS_READY_MS = 10_000;
/** Every container and network the sandbox starts, for cleaning up after a crash. */
export const SANDBOX_LABEL = 'agentic.sandbox';
/** The pid of the `agentic` process that started it: alive = in use, dead = left by a crash (`clean.ts`). */
export const PID_LABEL = 'agentic.pid';
const OWNER_LABELS = [`--label=${SANDBOX_LABEL}`, `--label=${PID_LABEL}=${process.pid}`];
/** Prefix of the dependency caches' named volumes, shared by every session. */
export const CACHE_VOLUME_PREFIX = 'agentic-cache-';

/**
 * Where each cache lives in the container: only the downloads, not the tool's home — `~/.gradle/init.d` or
 * `gradle.properties` written by one session would run in every later one.
 */
export const CACHE_MOUNTS: Record<CacheName, Array<{ volume: string; target: string }>> = {
  gradle: [
    { volume: 'gradle-caches', target: `${CONTAINER_PATHS.home}/.gradle/caches` },
    { volume: 'gradle-wrapper', target: `${CONTAINER_PATHS.home}/.gradle/wrapper` },
  ],
  maven: [{ volume: 'maven', target: `${CONTAINER_PATHS.home}/.m2/repository` }],
  npm: [{ volume: 'npm', target: `${CONTAINER_PATHS.home}/.npm` }],
  playwright: [{ volume: 'playwright', target: `${CONTAINER_PATHS.home}/.cache/ms-playwright` }],
};

/**
 * `sandbox.mode: container` — one throwaway container per session: the code and `out/` mounted
 * read-write (the origin repo read-only), flow artifacts read-only, the harness's state of this flow, nothing else
 * from the host. With `network`, the session sits on its own internal network whose only way out is an egress proxy
 * that tunnels HTTPS to the allowed hosts (`egress-proxy.ts`); its decisions land next to `out/` as `<out>.egress.log`.
 * Dependency caches are named volumes shared by all sessions (`CACHE_MOUNTS`).
 */
export class ContainerSandbox implements Sandbox {
  readonly label: string;
  readonly isolated = true;

  constructor(private readonly settings: ContainerSettings) {
    this.label = `container (${settings.engine})`;
  }

  view(workspace: SessionWorkspace): AgentView {
    return {
      codeDir: CONTAINER_PATHS.code,
      outDir: CONTAINER_PATHS.out,
      readOnlyMounts: contextTargets(workspace.readOnlyMounts),
    };
  }

  async exec(command: HarnessCommand, workspace: SessionWorkspace, options: ExecOptions): Promise<ProcessResult> {
    requireCredentials(command);
    const name = `agentic-${randomUUID().slice(0, 8)}`;
    const engine = this.settings.engine;
    const allowedHosts = sessionAllow(this.settings, workspace.network, command.allow);
    const egress = allowedHosts.length ? await startEgress(this.settings, name, allowedHosts) : undefined;
    try {
      const argv = [engine, ...containerArgs(this.settings, command, workspace, options, { name, network: egress?.network })];
      // `--env NAME` makes the engine read the value from its own environment
      return await runProcess(argv, { cwd: workspace.codeDir, env: { ...process.env, ...command.env }, stdin: command.stdin, ...options });
    } finally {
      // a client killed with SIGKILL (`process.ts` after its grace) leaves its container running
      await engineRun(engine, ['rm', '--force', '--volumes', name]);
      if (egress) await stopEgress(engine, egress, `${workspace.outDir}.egress.log`);
    }
  }
}

/**
 * A harness with none of its credentials set on the host can't sign in inside the container: it would open a session
 * that only says "Not logged in" (smoke 92-4), so the session stops before any container starts.
 */
export function requireCredentials(command: HarnessCommand, env: NodeJS.ProcessEnv = process.env): void {
  const names = command.passEnv ?? [];
  if (names.length && !names.some((name) => env[name] || command.env?.[name])) {
    throw new Error(`the harness in a container won't sign in: none of ${names.join(', ')} in the environment; \`agentic doctor\` tells where to get them`);
  }
}

/** The session's allowlist plus the image's hosts; a session without network stays without. */
export function sessionAllow(settings: ContainerSettings, network: string[], harnessHosts: readonly string[] = []): string[] {
  return network.length ? [...new Set([...network, ...harnessHosts, ...(settings.hosts ?? []), ...(settings.containers ? REGISTRY_HOSTS : [])])] : [];
}

export interface ContainerRun {
  name: string;
  /** The session's internal network; absent = `--network=none`. */
  network?: string;
}

export function containerArgs(
  settings: ContainerSettings,
  command: HarnessCommand,
  workspace: SessionWorkspace,
  options: ExecOptions,
  session: ContainerRun = { name: 'agentic-session' },
): string[] {
  const targets = contextTargets(workspace.readOnlyMounts);
  return [
    'run',
    '--rm',
    `--name=${session.name}`,
    ...OWNER_LABELS,
    // PID 1 forwards SIGTERM (a `.done` file, a timeout) to the harness; without it the container ignores it
    '--init',
    ...(options.interactive || command.stdin !== undefined ? ['--interactive'] : []),
    ...(options.interactive ? ['--tty'] : []),
    // files written in the mounts belong to the user: rootless podman maps the uid, docker runs as it
    ...(settings.engine === 'podman' ? ['--userns=keep-id'] : hostUser()),
    session.network ? `--network=${session.network}` : '--network=none',
    '--cap-drop=ALL',
    ...(settings.containers ? containersArgs(settings.engine) : ['--security-opt=no-new-privileges']),
    `--volume=${workspace.codeDir}:${CONTAINER_PATHS.code}${workspace.codeReadOnly ? ':ro' : ''}`,
    `--volume=${workspace.outDir}:${CONTAINER_PATHS.out}`,
    ...workspace.readOnlyMounts.map((source, index) => `--volume=${source}:${targets[index]}:ro`),
    ...(workspace.harnessSessions ? [`--volume=${workspace.harnessSessions.hostDir}:${path.posix.join(CONTAINER_PATHS.home, workspace.harnessSessions.sessionsHome)}`] : []),
    ...(settings.caches ?? []).flatMap((cache) => CACHE_MOUNTS[cache].map((mount) => `--volume=${CACHE_VOLUME_PREFIX}${mount.volume}:${mount.target}`)),
    `--workdir=${CONTAINER_PATHS.code}`,
    ...(session.network ? proxyEnv() : []),
    ...[...new Set([...Object.keys(command.env ?? {}), ...(command.passEnv ?? []).filter((name) => process.env[name] !== undefined)])].map((name) => `--env=${name}`),
    settings.image,
    HOME_ENTRY,
    ...(settings.containers ? [CONTAINERS_ENTRY] : []),
    ...command.argv,
  ];
}

/** Every client in the session goes through the egress proxy, by value: the proxy's address is no secret. */
function proxyEnv(): string[] {
  const proxy = `http://${EGRESS_HOST}:${EGRESS_PORT}`;
  return [
    ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((name) => `--env=${name}=${proxy}`),
    '--env=NO_PROXY=localhost,127.0.0.1',
    '--env=no_proxy=localhost,127.0.0.1',
    // Node's fetch (corepack, npx) and the JVM (Gradle, its wrapper, Maven) ignore the variables above unless told
    '--env=NODE_USE_ENV_PROXY=1',
    `--env=JAVA_TOOL_OPTIONS=${javaProxyOptions()}`,
  ];
}

/**
 * Rootless Podman in the session: user namespaces (newuidmap with file caps), fuse and tun devices,
 * a writable /proc/sys for its network setup; no SYS_ADMIN, NET_ADMIN or privileged mode. Its store is the session's
 * own, an anonymous volume gone with the container (`--rm`, `rm --volumes`) — a volume, not the container's layer:
 * overlay on the container's own overlayfs can't exec (Docker Desktop).
 */
function containersArgs(engine: ContainerEngine): string[] {
  return [
    ...CONTAINERS_CAPS.map((cap) => `--cap-add=${cap}`),
    '--device=/dev/fuse',
    '--device=/dev/net/tun',
    '--security-opt=label=disable',
    engine === 'docker' ? '--security-opt=systempaths=unconfined' : '--security-opt=unmask=ALL',
    // docker: newuidmap gains its capabilities from file caps, which no-new-privileges blocks
    ...(engine === 'docker' ? [] : ['--security-opt=no-new-privileges']),
    `--volume=${CONTAINERS_STORE}`,
  ];
}

function javaProxyOptions(): string {
  const hostPort = (scheme: string) => `-D${scheme}.proxyHost=${EGRESS_HOST} -D${scheme}.proxyPort=${EGRESS_PORT}`;
  return `${hostPort('https')} ${hostPort('http')} -Dhttp.nonProxyHosts=localhost|127.0.0.1`;
}

function hostUser(): string[] {
  return process.getuid && process.getgid ? [`--user=${process.getuid()}:${process.getgid()}`] : [];
}

function contextTargets(sources: string[]): string[] {
  const targets = sources.map((source) => path.posix.join(CONTAINER_PATHS.context, path.basename(source)));
  const duplicate = targets.find((target, index) => targets.indexOf(target) !== index);
  if (duplicate) throw new Error(`sandbox: two context files under the same path ${duplicate}`);
  return targets;
}

interface Egress {
  network: string;
  proxy: string;
}

/** The proxy's container and the session's internal network, whose only other member is the proxy. */
async function startEgress(settings: ContainerSettings, name: string, allow: string[]): Promise<Egress> {
  const { engine } = settings;
  const egress = { network: `${name}-net`, proxy: `${name}-egress` };
  await ensureNetwork(engine);
  try {
    await engineRun(engine, ['network', 'create', '--internal', ...OWNER_LABELS, egress.network], { strict: true });
    await engineRun(engine, egressArgs(settings, egress, allow), { strict: true });
    await engineRun(engine, ['network', 'connect', EGRESS_NETWORK, egress.proxy], { strict: true });
    await waitForProxy(engine, egress.proxy);
    return egress;
  } catch (error) {
    await stopEgress(engine, egress);
    throw error;
  }
}

export function egressArgs(settings: ContainerSettings, egress: Egress, allow: string[]): string[] {
  return [
    'run',
    '--detach',
    `--name=${egress.proxy}`,
    ...OWNER_LABELS,
    `--network=${egress.network}`,
    `--network-alias=${EGRESS_HOST}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--user=65534:65534',
    // the base image, whatever the session's layer: the proxy is the same everywhere
    settings.baseImage ?? settings.image,
    'node',
    EGRESS_IN_IMAGE,
    String(EGRESS_PORT),
    ...allow,
  ];
}

/** The shared outside network; created once, a parallel session may have just done it. */
async function ensureNetwork(engine: ContainerEngine): Promise<void> {
  if ((await engineRun(engine, ['network', 'inspect', EGRESS_NETWORK])).exitCode === 0) return;
  const created = await engineRun(engine, ['network', 'create', `--label=${SANDBOX_LABEL}`, EGRESS_NETWORK]);
  if (created.exitCode !== 0 && (await engineRun(engine, ['network', 'inspect', EGRESS_NETWORK])).exitCode !== 0) {
    throw new Error(`sandbox: could not create network ${EGRESS_NETWORK}: ${created.stderr.trim()}`);
  }
}

async function waitForProxy(engine: ContainerEngine, proxy: string): Promise<void> {
  const deadline = Date.now() + EGRESS_READY_MS;
  while (Date.now() < deadline) {
    if ((await engineRun(engine, ['logs', proxy])).stdout.includes('listening')) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`sandbox: proxy ${proxy} did not start within ${EGRESS_READY_MS / 1000} s`);
}

async function stopEgress(engine: ContainerEngine, egress: Egress, logFile?: string): Promise<void> {
  if (logFile) {
    const logs = await engineRun(engine, ['logs', egress.proxy]);
    if (logs.exitCode === 0) fs.writeFileSync(logFile, logs.stdout);
  }
  await engineRun(engine, ['rm', '--force', egress.proxy]);
  await engineRun(engine, ['network', 'rm', egress.network]);
}
