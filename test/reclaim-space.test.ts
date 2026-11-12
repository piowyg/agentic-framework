import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_HASH_LABEL, reclaimSpace } from '../src/sandbox/image.js';
import { tmpDir } from './helpers.js';

const originalPath = process.env.PATH;

/** An engine on PATH that records its arguments, one call per line. */
function recordingEngine(name: string): () => string[] {
  const bin = tmpDir();
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;
  return () => fs.readFileSync(calls, 'utf8').trim().split('\n');
}

describe('reclaimSpace after sandbox build', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('removes only the replaced images of this framework; on macOS Podman trims its VM disk', async () => {
    const calls = recordingEngine('podman');
    await reclaimSpace('podman', 'darwin');
    expect(calls()).toEqual([`image prune --force --filter label=${IMAGE_HASH_LABEL}`, 'machine ssh sudo fstrim -a']);
  });

  it('elsewhere there is no VM to trim', async () => {
    const calls = recordingEngine('docker');
    await reclaimSpace('docker', 'darwin');
    expect(calls()).toEqual([`image prune --force --filter label=${IMAGE_HASH_LABEL}`]);
  });
});
