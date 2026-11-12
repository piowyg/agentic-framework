import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContainerEngine } from '../src/config/types.js';
import { ContainerSandbox, type ContainerSettings } from '../src/sandbox/container.js';
import { engineRun } from '../src/sandbox/engine.js';
import { tmpDir } from './helpers.js';

// On a real engine, with `agentic/base` built from this tree: `AGENTIC_IT_ENGINE=podman|docker npx vitest run test/sandbox-engine.test.ts`.
// What only an image and an engine show: the image's file modes, the entry script, the inner Podman, the proxy.
const engine = process.env.AGENTIC_IT_ENGINE as ContainerEngine | undefined;

describe.skipIf(!engine)(`sandbox on ${engine ?? 'a real engine'}`, () => {
  async function session(script: string, options: { network?: string[]; containers?: boolean } = {}) {
    const dir = tmpDir();
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    const settings: ContainerSettings = { engine: engine!, image: 'agentic/base', containers: options.containers ?? true };
    const result = await new ContainerSandbox(settings).exec(
      { argv: ['sh', '-c', script] },
      { codeDir: dir, outDir, readOnlyMounts: [], network: options.network ?? [] },
      { interactive: false, timeoutMs: 120_000 },
    );
    const egressLog = path.join(dir, 'out.egress.log');
    return { ...result, egress: fs.existsSync(egressLog) ? fs.readFileSync(egressLog, 'utf8') : '' };
  }

  it('the image has no setuid or setgid binary (Docker with `sandbox.containers` runs without no-new-privileges)', async () => {
    // as root: the session's uid can't list every directory
    const result = await engineRun(engine!, ['run', '--rm', '--user=0', 'agentic/base', 'find', '/', '-xdev', '-perm', '/6000', '-type', 'f']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('the entry script: subordinate ids around the host uid, the docker CLI on the inner Podman', async () => {
    const result = await session('cat /etc/subuid && docker info --format "{{.ServerVersion}}"');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^\S+:1:\d+\n\S+:\d+:\d+\n\d+\.\d+\.\d+\n$/);
  });

  it('the home from passwd is /home/agent, not the clone, with and without containers', async () => {
    // Java, Maven and Testcontainers read passwd, not $HOME (acceptance smoke: Java prefs committed from /workspace)
    for (const containers of [false, true]) {
      const result = await session('getent passwd "$(id -u)" | cut -d: -f6; getent passwd | grep -c ":$(id -u):"', { containers });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe('/home/agent\n1\n');
    }
  });

  it("sessions don't share the inner Podman's store", async () => {
    const first = await session('podman volume create probe > /dev/null && podman volume ls --quiet');
    expect(first.stdout.trim(), first.stderr).toBe('probe');
    const second = await session('podman volume ls --quiet');
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout.trim()).toBe('');
  });

  it('with network: an allowed host through the proxy, any other refused, both in the egress log', async () => {
    const curl = (url: string) => `curl --silent --output /dev/null --write-out '%{http_code}' ${url}; echo " exit $?"`;
    const result = await session(`${curl('https://registry.npmjs.org/')}; ${curl('https://example.com/')}`, { network: ['registry.npmjs.org'], containers: false });
    const [allowed, other] = result.stdout.trim().split('\n');
    expect(allowed).toBe('200 exit 0');
    // the proxy's 403 to the CONNECT: curl never gets an HTTP answer from the host
    expect(other).toMatch(/^000 exit [1-9]\d*$/);
    expect(result.egress).toMatch(/^listening \d+\nallow registry\.npmjs\.org\ndeny example\.com:443\n/);
  });
});
