import type { AgenticConfig } from '../config/types.js';
import { ContainerSandbox } from './container.js';
import { HostSandbox } from './host.js';
import { resolveImage } from './image.js';
import type { Sandbox } from './types.js';

/** `repoRoot` picks the stack's image (`sandbox.image.stack: auto`). */
export function createSandbox(config: AgenticConfig['sandbox'], repoRoot?: string): Sandbox {
  if (config.mode === 'none') return new HostSandbox();
  const { image, base, hosts } = resolveImage(config.image, repoRoot);
  return new ContainerSandbox({ engine: config.engine, image, baseImage: base, hosts, caches: config.caches, containers: config.containers });
}
