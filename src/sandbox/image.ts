import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContainerEngine } from '../config/types.js';
import { PACKAGE_ROOT } from '../paths.js';
import { engineRun } from './engine.js';
import { runProcess } from './process.js';

/** The base image's build context, shipped with the framework. */
export const BASE_IMAGE_DIR = path.join(PACKAGE_ROOT, 'sandbox', 'base');
/** Set at build to the hash of the build context: an image built from older files is stale. */
export const IMAGE_HASH_LABEL = 'agentic.image-hash';

/** The image `agentic sandbox build` makes; another `sandbox.image.base` is the user's to build. */
export const BASE_IMAGE = 'agentic/base';
/**
 * The base image has Node with corepack: npm, and yarn's registries when the repo pins yarn; and Chromium's system
 * libraries, the browser itself coming from Playwright's CDN (`npx playwright install chromium`).
 */
const BASE_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com'];

/**
 * Stack layers on top of `sandbox.image.base`, each with the hosts its build tools need on top of
 * `sandbox.network.allow` — a repo that sets its own allowlist doesn't have to know them. Node needs no layer:
 * the base image has Node and corepack.
 */
export const STACKS = {
  jvm: {
    image: 'agentic/jvm',
    dir: path.join(PACKAGE_ROOT, 'sandbox', 'jvm'),
    hosts: [
      'repo.maven.apache.org',
      'repo1.maven.org',
      'services.gradle.org',
      'downloads.gradle.org',
      'plugins.gradle.org',
      'plugins-artifacts.gradle.org',
      // Gradle distributions redirect to GitHub releases; without a token GitHub is read-only
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ],
  },
} as const;
export type Stack = keyof typeof STACKS;

function isStack(name: string): name is Stack {
  return Object.hasOwn(STACKS, name);
}
/** `sandbox.image.stack` values besides a stack's name or an image of the user's own. */
export const NO_STACK = ['none', 'node'] as const;

/** The image a session of this repo runs in, and the hosts its tools need on top of the allowlist (none for the user's own image). */
export interface ResolvedImage {
  image: string;
  /** The base image, when `image` is a stack layer built on it. */
  base: string;
  stack?: Stack;
  hosts: readonly string[];
}

const BUILD_FILES: Record<Stack, string[]> = {
  jvm: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml'],
};

/**
 * `sandbox.image`: `stack: auto` looks for build files in the repo and its top-level directories (a Gradle
 * backend next to a frontend is a JVM repo); a name from `STACKS` picks that layer; `none`/`node` the base image;
 * anything else is an image of the user's own, run as is.
 */
export function resolveImage(image: { base: string; stack: string }, repoRoot?: string): ResolvedImage {
  const stack = image.stack === 'auto' ? (repoRoot ? detectImageStack(repoRoot) : undefined) : image.stack;
  const baseHosts = image.base === BASE_IMAGE ? BASE_HOSTS : [];
  if (!stack || (NO_STACK as readonly string[]).includes(stack)) return { image: image.base, base: image.base, hosts: baseHosts };
  if (isStack(stack)) return { image: STACKS[stack].image, base: image.base, stack, hosts: [...baseHosts, ...STACKS[stack].hosts] };
  return { image: stack, base: image.base, hosts: [] };
}

export function detectImageStack(root: string): Stack | undefined {
  const dirs = [root, ...topLevelDirs(root)];
  return (Object.keys(BUILD_FILES) as Stack[]).find((stack) => dirs.some((dir) => BUILD_FILES[stack].some((file) => fs.existsSync(path.join(dir, file)))));
}

function topLevelDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export type ImageStatus = 'ok' | 'missing' | 'stale';

/** The build context of an image this framework makes; undefined for the user's own. */
function buildDir(image: string): string | undefined {
  if (image === BASE_IMAGE) return BASE_IMAGE_DIR;
  return Object.values(STACKS).find((stack) => stack.image === image)?.dir;
}

/** The egress proxy, compiled; baked into the base image (`egress-proxy.ts`). */
const EGRESS_BUILD_SOURCE = path.join(PACKAGE_ROOT, 'dist', 'sandbox', 'egress-proxy.js');
export const EGRESS_SCRIPT_NAME = 'egress-proxy.mjs';

/**
 * The build context's files as `name → source`: the image's directory, and for the base image the egress proxy.
 * The proxy is copied in, not mounted at run time: the VM of Podman or Docker Desktop on macOS shares only some
 * host directories (`/Users`), and a global npm install lives elsewhere (`/opt/homebrew`).
 */
function contextFiles(dir: string): Array<[string, string]> {
  const files = fs.readdirSync(dir).sort().map((name): [string, string] => [name, path.join(dir, name)]);
  return dir === BASE_IMAGE_DIR ? [...files, [EGRESS_SCRIPT_NAME, EGRESS_BUILD_SOURCE]] : files;
}

/** Hash of every file in the build context, by name and content. */
export function imageHash(dir = BASE_IMAGE_DIR): string {
  const hash = createHash('sha256');
  for (const [name, source] of contextFiles(dir)) {
    hash.update(`${name}\0`).update(fs.readFileSync(source)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * A stack layer's label also covers the image it was built on, by the engine's id: a layer on an older base, or on
 * another one (`sandbox.image.base`), is stale even when its own files didn't change.
 */
export function layerHash(dir: string, baseId: string): string {
  return createHash('sha256').update(`${imageHash(dir)}\0${baseId}`).digest('hex').slice(0, 16);
}

/** The label `buildImage` gives the image from `dir`, a stack layer on `base`; undefined while `base` isn't there. */
async function expectedHash(engine: ContainerEngine, dir: string, base: string): Promise<string | undefined> {
  if (dir === BASE_IMAGE_DIR) return imageHash(dir);
  const baseId = await inspectImage(engine, base, '{{.Id}}');
  return baseId ? layerHash(dir, baseId) : undefined;
}

/** `<engine> image inspect --format`; undefined when there's no such image. */
async function inspectImage(engine: ContainerEngine, image: string, format: string): Promise<string | undefined> {
  const result = await engineRun(engine, ['image', 'inspect', '--format', format, image], { timeoutMs: 15_000 });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** The engine's view of `image` (on `base`): absent, built from other files than this framework's (its own images only), or current. */
export async function imageStatus(engine: ContainerEngine, image: string, base = BASE_IMAGE): Promise<ImageStatus> {
  const label = await inspectImage(engine, image, `{{ index .Config.Labels "${IMAGE_HASH_LABEL}" }}`);
  if (label === undefined) return 'missing';
  const dir = buildDir(image);
  return !dir || label === (await expectedHash(engine, dir, base)) ? 'ok' : 'stale';
}

/**
 * `<engine> build` of one of this framework's images (a stack layer on `base`), its output on the terminal;
 * resolves to the exit code.
 */
export async function buildImage(engine: ContainerEngine, image: string, base = BASE_IMAGE): Promise<number> {
  const dir = buildDir(image);
  if (!dir) throw new Error(`${image} is not a framework image; build it yourself`);
  const label = await expectedHash(engine, dir, base);
  if (!label) throw new Error(`missing image ${base}, which ${image} is built on; build it or \`${engine} pull ${base}\``);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-build-'));
  try {
    for (const [name, source] of contextFiles(dir)) fs.copyFileSync(source, path.join(context, name));
    const argv = [engine, 'build', `--label=${IMAGE_HASH_LABEL}=${label}`, ...(dir === BASE_IMAGE_DIR ? [] : [`--build-arg=BASE=${base}`]), `--tag=${image}`, context];
    return (await runProcess(argv, { cwd: context, env: process.env, interactive: true })).exitCode;
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

/**
 * After a rebuild: the images it replaced (untagged, with this framework's label — no one else's) go, and on macOS
 * Podman's VM hands the freed blocks back to the host — its disk file only grows otherwise (2026-10-20: 21 GB back).
 * Best effort: a failure leaves the space taken, nothing else.
 */
export async function reclaimSpace(engine: ContainerEngine, platform = process.platform): Promise<void> {
  await engineRun(engine, ['image', 'prune', '--force', '--filter', `label=${IMAGE_HASH_LABEL}`]);
  if (engine === 'podman' && platform === 'darwin') await engineRun(engine, ['machine', 'ssh', 'sudo fstrim -a'], { timeoutMs: 5 * 60_000 });
}
