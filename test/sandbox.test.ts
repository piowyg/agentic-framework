import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { runDoctor } from '../src/doctor.js';
import type { PodmanMachine } from '../src/sandbox/podman-machine.js';
import { fakeRegistry, FAKE_TASKS, type FakeScript } from '../src/harness/fake.js';
import type { HarnessCommand } from '../src/harness/types.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { harnessSessionsDir, rememberSessionDir } from '../src/orchestrator/harness-sessions.js';
import { collectArtifact, MAX_ARTIFACT_BYTES } from '../src/sandbox/artifacts.js';
import { ContainerSandbox, containerArgs, egressArgs, REGISTRY_HOSTS, requireCredentials, sessionAllow } from '../src/sandbox/container.js';
import { connectTarget, createEgressProxy, isAllowed } from '../src/sandbox/egress-proxy.js';
import { HostSandbox } from '../src/sandbox/host.js';
import { imageHash, layerHash, resolveImage, STACKS } from '../src/sandbox/image.js';
import { createSandbox } from '../src/sandbox/index.js';
import type { SessionWorkspace } from '../src/sandbox/types.js';
import { committedRepo, sandboxEnv, tmpDir, write, TEST_CONFIG } from './helpers.js';

function workspace(overrides: Partial<SessionWorkspace> = {}): SessionWorkspace {
  return { codeDir: '/flows/s/clones/g1', outDir: '/flows/s/out/implement-g1-t1', readOnlyMounts: [], network: [], ...overrides };
}

describe('collectArtifact', () => {
  it('copies a regular file from out/ into the flow directory', () => {
    const outDir = tmpDir();
    const flowDir = tmpDir();
    write(outDir, 'spec.md', 'spec');
    expect(collectArtifact(outDir, 'spec.md', flowDir)).toBe(true);
    expect(fs.readFileSync(path.join(flowDir, 'spec.md'), 'utf8')).toBe('spec');
  });

  it('a missing artifact keeps the flow copy (e.g. a pasted ticket)', () => {
    const flowDir = tmpDir();
    write(flowDir, 'ticket.md', 'pasted');
    expect(collectArtifact(tmpDir(), 'ticket.md', flowDir)).toBe(false);
    expect(fs.readFileSync(path.join(flowDir, 'ticket.md'), 'utf8')).toBe('pasted');
  });

  it('refuses symlinks, directories, oversized files and paths', () => {
    const outDir = tmpDir();
    const flowDir = tmpDir();
    fs.symlinkSync(write(tmpDir(), 'secret', 'x'), path.join(outDir, 'ticket.md'));
    fs.mkdirSync(path.join(outDir, 'spec.md'));
    write(outDir, 'tasks.yaml', 'x'.repeat(MAX_ARTIFACT_BYTES + 1));
    expect(() => collectArtifact(outDir, 'ticket.md', flowDir)).toThrow(/symlink not allowed/);
    expect(() => collectArtifact(outDir, 'spec.md', flowDir)).toThrow(/not a regular file/);
    expect(() => collectArtifact(outDir, 'tasks.yaml', flowDir)).toThrow(/file too large/);
    expect(() => collectArtifact(outDir, '../state.json', flowDir)).toThrow(/a file name, not a path/);
    expect(fs.readdirSync(flowDir)).toEqual([]);
  });
});

describe('sessions write to their own out/', () => {
  function setup(script: FakeScript) {
    const root = tmpDir();
    const harnesses = fakeRegistry(script);
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
    const run = () =>
      runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    return { workDir, harnesses, run };
  }

  it('the prompt points at out/ and the read-only context; the artifact is collected from out/', async () => {
    const { workDir, harnesses, run } = setup({});
    expect((await run()).status).toBe('done');
    const breakdown = harnesses.calls().find((call) => call.kind === 'breakdown')!;
    expect(breakdown.outDir).toBe(path.join(workDir, 'out', 'breakdown'));
    expect(breakdown.prompt).toContain(`Write \`${path.join(workDir, 'out', 'breakdown')}/tasks.yaml\``);
    expect(breakdown.prompt).toContain(`Read-only context:\n- ${path.join(workDir, 'ticket.md')}\n- ${path.join(workDir, 'spec.md')}\n`);
    expect(breakdown.prompt).toContain(`Follow the stage skill: ${path.join(workDir, 'out', 'breakdown.skills', 'agentic-breakdown', 'SKILL.md')}`);
    expect(fs.readFileSync(path.join(workDir, 'tasks.yaml'), 'utf8')).toBe(FAKE_TASKS);
    // implementation reads the approved plan, not a tasks.yaml edited after the gate
    const implement = harnesses.calls().find((call) => call.kind === 'implement')!;
    expect(implement.prompt).toContain(path.join(workDir, 'tasks.approved.yaml'));
    expect(implement.prompt).not.toContain(`${path.join(workDir, 'tasks.yaml')}`);
  });

  it('a rerun session starts with an empty out/, so a stale artifact does not pass for its result', async () => {
    let call = 0;
    const { workDir, run } = setup({
      breakdown: (request) => {
        call++;
        if (call === 1) return { files: { 'tasks.yaml': 'groups: [' } };
        // the second session writes nothing: the invalid plan stays and the flow pauses again
        expect(fs.readdirSync(request.outDir)).toEqual([]);
        return { output: 'ok' };
      },
    });
    expect((await run()).paused).toMatchObject({ reason: 'error' });
    expect((await run()).paused).toMatchObject({ reason: 'error' });
    expect(call).toBe(2);
    expect(fs.readFileSync(path.join(workDir, 'tasks.yaml'), 'utf8')).toBe('groups: [');
  });
});

describe('HostSandbox', () => {
  const node = (script: string, env?: Record<string, string>): HarnessCommand => ({ argv: [process.execPath, '-e', script], env });

  it('runs the command in the code directory with the harness env, without a shell', async () => {
    const codeDir = tmpDir();
    const result = await new HostSandbox().exec(
      node('process.stdout.write(process.cwd()); process.stderr.write(process.env.HARNESS_TOKEN); process.exit(3)', { HARNESS_TOKEN: 't0k' }),
      workspace({ codeDir }),
      { interactive: false },
    );
    expect(result).toMatchObject({ exitCode: 3, stdout: codeDir, stderr: 't0k' });
    expect(result.timedOut).toBeUndefined();
  });

  it('passes stdin, kills on timeout, rejects a missing binary', async () => {
    const sandbox = new HostSandbox();
    const codeDir = tmpDir();
    const echo = await sandbox.exec({ argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], stdin: 'prompt' }, workspace({ codeDir }), { interactive: false });
    expect(echo.stdout).toBe('prompt');
    const hung = await sandbox.exec(node('setTimeout(() => {}, 60_000)'), workspace({ codeDir }), { interactive: false, timeoutMs: 100 });
    expect(hung.timedOut).toBe(true);
    await expect(sandbox.exec({ argv: ['agentic-no-such-binary'] }, workspace({ codeDir }), { interactive: false })).rejects.toThrow(
      /cannot run `agentic-no-such-binary`/,
    );
  });

  it('a session ends once its done file appears (the orchestrator gives one to interactive sessions)', async () => {
    const codeDir = tmpDir();
    const doneFile = path.join(tmpDir(), '.done');
    setTimeout(() => fs.writeFileSync(doneFile, ''), 200);
    const result = await new HostSandbox().exec(node('setTimeout(() => {}, 60_000)'), workspace({ codeDir }), { interactive: false, doneFile });
    expect(result.timedOut).toBeUndefined();
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('a session ends when its process exits, though a background child still holds its stdout', async () => {
    const codeDir = tmpDir();
    const background = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()`;
    const result = await new HostSandbox().exec(node(`process.stdout.write('done\\n'); ${background}; process.exit(0)`), workspace({ codeDir }), { interactive: false });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'done\n' });
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('streams stdout to the live file while the process runs, not only after it ends', async () => {
    const codeDir = tmpDir();
    const liveOutput = path.join(tmpDir(), 'transcripts', 'implement-g1-t1-s1.jsonl');
    const doneFile = path.join(tmpDir(), '.done');
    const running = new HostSandbox().exec(
      node(`process.stdout.write('{"type":"system"}\\n'); setInterval(() => require('fs').existsSync(${JSON.stringify(doneFile)}) && process.exit(0), 50)`),
      workspace({ codeDir }),
      { interactive: false, liveOutput },
    );
    await expect.poll(() => fs.existsSync(liveOutput) && fs.readFileSync(liveOutput, 'utf8'), { timeout: 5000 }).toBe('{"type":"system"}\n');
    fs.writeFileSync(doneFile, '');
    expect((await running).stdout).toBe('{"type":"system"}\n');
  });
});

describe('harness state in a container', () => {
  it("each session its own directory; a resumed one gets back the directory its id ran in", () => {
    const workDir = tmpDir();
    const first = harnessSessionsDir(workDir, 'claude');
    const second = harnessSessionsDir(workDir, 'claude');
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join(workDir, 'harness', 'claude'));
    rememberSessionDir(first, 'session-1');
    expect(harnessSessionsDir(workDir, 'claude', 'session-1')).toBe(first);
    // an id never recorded, or not an id at all, starts afresh
    expect([second, first]).not.toContain(harnessSessionsDir(workDir, 'claude', 'session-2'));
    expect(path.dirname(harnessSessionsDir(workDir, 'claude', '../../etc'))).toBe(path.join(workDir, 'harness', 'claude'));
  });
});

describe('ContainerSandbox', () => {
  const podman = { engine: 'podman' as const, image: 'agentic/base' };

  it('mounts only the code, out/ and read-only context; env by name; no network', () => {
    const args = containerArgs(
      podman,
      { argv: ['claude', '-p', 'x'], env: { ANTHROPIC_API_KEY: 'sk-secret' } },
      workspace({ readOnlyMounts: ['/flows/s/ticket.approved.md', '/flows/s/spec.md'] }),
      { interactive: false },
      { name: 'agentic-1234' },
    );
    expect(args).toEqual([
      'run',
      '--rm',
      '--name=agentic-1234',
      '--label=agentic.sandbox',
      `--label=agentic.pid=${process.pid}`,
      '--init',
      '--userns=keep-id',
      '--network=none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--volume=/flows/s/clones/g1:/workspace',
      '--volume=/flows/s/out/implement-g1-t1:/out',
      '--volume=/flows/s/ticket.approved.md:/context/ticket.approved.md:ro',
      '--volume=/flows/s/spec.md:/context/spec.md:ro',
      '--workdir=/workspace',
      '--env=ANTHROPIC_API_KEY',
      'agentic/base',
      '/usr/local/lib/agentic/home-entry.sh',
      'claude',
      '-p',
      'x',
    ]);
    expect(args.join(' ')).not.toContain('sk-secret');
  });

  it('docker runs as the host user; an interactive session gets a tty', () => {
    const args = containerArgs({ ...podman, engine: 'docker' }, { argv: ['claude'] }, workspace(), { interactive: true });
    expect(args).not.toContain('--userns=keep-id');
    expect(args).toContain(`--user=${process.getuid!()}:${process.getgid!()}`);
    expect(args).toEqual(expect.arrayContaining(['--init', '--interactive', '--tty']));
  });

  it('with a network: the internal network and the proxy in the environment, by value (no secret)', () => {
    const args = containerArgs(podman, { argv: ['x'] }, workspace({ network: ['api.anthropic.com'] }), { interactive: false }, { name: 'a', network: 'a-net' });
    expect(args).toContain('--network=a-net');
    expect(args).not.toContain('--network=none');
    expect(args).toEqual(expect.arrayContaining(['--env=HTTPS_PROXY=http://egress:3128', '--env=https_proxy=http://egress:3128', '--env=NO_PROXY=localhost,127.0.0.1']));
    // Node's fetch and the JVM don't read the variables above
    expect(args).toContain('--env=NODE_USE_ENV_PROXY=1');
    expect(args.find((arg) => arg.startsWith('--env=JAVA_TOOL_OPTIONS='))).toMatch(/-Dhttps\.proxyHost=egress -Dhttps\.proxyPort=3128 .*-Dhttp\.nonProxyHosts=/);
    expect(containerArgs(podman, { argv: ['x'] }, workspace(), { interactive: false }).join(' ')).not.toMatch(/PROXY|JAVA_TOOL_OPTIONS/);
  });

  it("the image's hosts join the allowlist of a session with network; a session without network stays without", () => {
    const jvm = { ...podman, image: 'agentic/jvm', hosts: ['repo.maven.apache.org', 'services.gradle.org'] };
    expect(sessionAllow(jvm, ['api.anthropic.com', 'repo.maven.apache.org'])).toEqual(['api.anthropic.com', 'repo.maven.apache.org', 'services.gradle.org']);
    expect(sessionAllow(jvm, [])).toEqual([]);
  });

  it('dependency caches: named volumes over the downloads only, not the tool homes', () => {
    const args = containerArgs({ ...podman, caches: ['gradle', 'maven', 'npm', 'playwright'] }, { argv: ['x'] }, workspace(), { interactive: false });
    expect(args.filter((arg) => arg.includes('agentic-cache-'))).toEqual([
      '--volume=agentic-cache-gradle-caches:/home/agent/.gradle/caches',
      '--volume=agentic-cache-gradle-wrapper:/home/agent/.gradle/wrapper',
      '--volume=agentic-cache-maven:/home/agent/.m2/repository',
      '--volume=agentic-cache-npm:/home/agent/.npm',
      '--volume=agentic-cache-playwright:/home/agent/.cache/ms-playwright',
    ]);
  });

  it('containers: rootless Podman inside — a few capabilities, fuse and tun, its own store on an anonymous volume, the entry script', () => {
    const args = containerArgs({ ...podman, containers: true }, { argv: ['./gradlew', 'test'] }, workspace(), { interactive: false });
    expect(args).toEqual(expect.arrayContaining(['--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--device=/dev/fuse', '--device=/dev/net/tun', '--security-opt=unmask=ALL']));
    expect(args.join(' ')).not.toMatch(/SYS_ADMIN|NET_ADMIN|--privileged/);
    expect(args).toContain('--security-opt=no-new-privileges');
    // the session's own store: parallel sessions never see each other's containers
    expect(args).toContain('--volume=/home/agent/.local/share/containers');
    expect(args.slice(-5)).toEqual(['agentic/base', '/usr/local/lib/agentic/home-entry.sh', '/usr/local/lib/agentic/containers-entry.sh', './gradlew', 'test']);
    // docker: newuidmap's file caps need privileges no-new-privileges blocks; /proc/sys writable instead of unmask
    const docker = containerArgs({ ...podman, engine: 'docker', containers: true }, { argv: ['x'] }, workspace(), { interactive: false });
    expect(docker).not.toContain('--security-opt=no-new-privileges');
    expect(docker).toContain('--security-opt=systempaths=unconfined');
    const plain = containerArgs(podman, { argv: ['x'] }, workspace(), { interactive: false }).join(' ');
    expect(plain).not.toMatch(/cap-add|\/dev\/fuse|containers-entry|share\/containers/);
  });

  it('every session starts with the home entry: Java takes its home from passwd, which would point at the clone', () => {
    // acceptance smoke: Podman's keep-id gave the uid /workspace as its home; Java prefs landed in a commit
    for (const engine of ['podman', 'docker'] as const) {
      const args = containerArgs({ ...podman, engine }, { argv: ['./gradlew', 'test'] }, workspace(), { interactive: false });
      expect(args.slice(-4)).toEqual(['agentic/base', '/usr/local/lib/agentic/home-entry.sh', './gradlew', 'test']);
    }
  });

  it('containers: Docker Hub joins the allowlist of a session with network', () => {
    expect(sessionAllow({ ...podman, containers: true }, ['api.anthropic.com'])).toEqual(['api.anthropic.com', ...REGISTRY_HOSTS]);
    expect(sessionAllow({ ...podman, containers: true }, [])).toEqual([]);
    expect(sessionAllow(podman, ['api.anthropic.com'])).toEqual(['api.anthropic.com']);
  });

  it("the human's repo read-only; the session's own harness sessions under HOME", () => {
    const args = containerArgs(
      podman,
      { argv: ['x'] },
      workspace({ codeDir: '/repo', codeReadOnly: true, harnessSessions: { hostDir: '/flows/s/harness/claude/a1', sessionsHome: '.claude/projects' } }),
      { interactive: false },
    );
    expect(args).toContain('--volume=/repo:/workspace:ro');
    expect(args).toContain('--volume=/flows/s/harness/claude/a1:/home/agent/.claude/projects');
  });

  it('credentials by name, only the ones set on the host', () => {
    const before = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret';
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const args = containerArgs(podman, { argv: ['x'], passEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] }, workspace(), { interactive: false });
      expect(args).toContain('--env=CLAUDE_CODE_OAUTH_TOKEN');
      expect(args).not.toContain('--env=ANTHROPIC_API_KEY');
      expect(args.join(' ')).not.toContain('oauth-secret');
    } finally {
      process.env = before;
    }
  });

  it('a session without any of its credentials stops before a container starts', () => {
    const command = { argv: ['x'], passEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] };
    expect(() => requireCredentials(command, {})).toThrow(/won't sign in: none of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => requireCredentials(command, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' })).not.toThrow();
    expect(() => requireCredentials({ argv: ['x'] }, {})).not.toThrow();
    // a gateway token read from settings.json travels in `env`, not in the host's environment
    expect(() => requireCredentials({ argv: ['x'], passEnv: ['ANTHROPIC_AUTH_TOKEN'], env: { ANTHROPIC_AUTH_TOKEN: 'gw' } }, {})).not.toThrow();
  });

  it("the harness's own hosts (a company gateway) join the allowlist; a variable in both env and passEnv is passed once", () => {
    expect(sessionAllow(podman, ['api.anthropic.com'], ['llm.example.com'])).toEqual(['api.anthropic.com', 'llm.example.com']);
    expect(sessionAllow(podman, [], ['llm.example.com'])).toEqual([]);
    const before = process.env;
    process.env = { ...before, ANTHROPIC_AUTH_TOKEN: 'gw' };
    try {
      const args = containerArgs(podman, { argv: ['x'], env: { ANTHROPIC_AUTH_TOKEN: 'gw' }, passEnv: ['ANTHROPIC_AUTH_TOKEN'] }, workspace(), { interactive: false });
      expect(args.filter((arg) => arg === '--env=ANTHROPIC_AUTH_TOKEN')).toHaveLength(1);
    } finally {
      process.env = before;
    }
  });

  it('the egress proxy: read-only, no capabilities, nobody, the allowlist as arguments', () => {
    const args = egressArgs(podman, { network: 'a-net', proxy: 'a-egress' }, ['api.anthropic.com', '.npmjs.org']);
    expect(args).toEqual(expect.arrayContaining(['--detach', '--name=a-egress', '--network=a-net', '--network-alias=egress', '--cap-drop=ALL', '--read-only', '--user=65534:65534']));
    expect(args.slice(-6)).toEqual(['agentic/base', 'node', '/usr/local/lib/agentic/egress-proxy.mjs', '3128', 'api.anthropic.com', '.npmjs.org']);
  });

  it('the agent sees fixed paths', () => {
    const view = new ContainerSandbox(podman).view(workspace({ readOnlyMounts: ['/flows/s/tasks.approved.yaml'] }));
    expect(view).toEqual({ codeDir: '/workspace', outDir: '/out', readOnlyMounts: ['/context/tasks.approved.yaml'] });
  });

  it('refuses colliding context names', () => {
    expect(() => containerArgs(podman, { argv: ['x'] }, workspace({ readOnlyMounts: ['/a/spec.md', '/b/spec.md'] }), { interactive: false })).toThrow(
      /two context files/,
    );
  });

  it('the image: a JVM repo (also with Gradle one level down) gets the jvm layer and its hosts; base otherwise', () => {
    const image = TEST_CONFIG.sandbox.image;
    const backend = tmpDir();
    write(backend, 'backend/build.gradle.kts', '');
    write(backend, 'frontend/package.json', '{}');
    expect(resolveImage(image, backend)).toEqual(expect.objectContaining({ image: 'agentic/jvm', base: 'agentic/base', stack: 'jvm' }));
    expect(resolveImage(image, backend).hosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'repo.maven.apache.org', 'services.gradle.org']));
    const maven = tmpDir();
    write(maven, 'pom.xml', '');
    expect(resolveImage(image, maven).image).toBe('agentic/jvm');
    const nodeRepo = tmpDir();
    write(nodeRepo, 'package.json', '{}');
    write(nodeRepo, 'node_modules/x/pom.xml', '');
    expect(resolveImage(image, nodeRepo)).toEqual({ image: 'agentic/base', base: 'agentic/base', hosts: ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com'] });
    expect(resolveImage({ ...image, stack: 'jvm' }, nodeRepo).image).toBe('agentic/jvm');
    expect(resolveImage({ ...image, stack: 'none' }, backend).image).toBe('agentic/base');
    // the user's own image runs as is, with no hosts of ours
    expect(resolveImage({ ...image, stack: 'registry.example/team/java:21' }, backend)).toEqual({ image: 'registry.example/team/java:21', base: 'agentic/base', hosts: [] });
  });

  it("a stack layer's hash covers the image it was built on: a layer on an older or another base is stale", () => {
    const jvm = STACKS.jvm.dir;
    expect(layerHash(jvm, 'sha256:old')).not.toBe(layerHash(jvm, 'sha256:new'));
    expect(layerHash(jvm, 'sha256:old')).toBe(layerHash(jvm, 'sha256:old'));
    expect(layerHash(jvm, 'sha256:old')).not.toBe(imageHash(jvm));
  });

  it('createSandbox follows sandbox.mode and sandbox.engine', () => {
    expect(createSandbox(TEST_CONFIG.sandbox).label).toBe('container (podman)');
    expect(createSandbox({ ...TEST_CONFIG.sandbox, engine: 'docker' }).label).toBe('container (docker)');
    expect(createSandbox({ ...TEST_CONFIG.sandbox, mode: 'none' })).toBeInstanceOf(HostSandbox);
  });
});

describe('egress proxy', () => {
  it('allows HTTPS to listed hosts; a leading dot allows the subdomains', () => {
    const allow = ['api.anthropic.com', '.npmjs.org'];
    expect(isAllowed(allow, 'api.anthropic.com', 443)).toBe(true);
    expect(isAllowed(allow, 'API.Anthropic.com.', 443)).toBe(true);
    expect(isAllowed(allow, 'registry.npmjs.org', 443)).toBe(true);
    expect(isAllowed(allow, 'evil-api.anthropic.com', 443)).toBe(false);
    expect(isAllowed(allow, 'anthropic.com', 443)).toBe(false);
    expect(isAllowed(allow, 'npmjs.org.evil.com', 443)).toBe(false);
    expect(isAllowed(allow, 'api.anthropic.com', 22)).toBe(false);
  });

  it('reads CONNECT targets, IPv6 too', () => {
    expect(connectTarget('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(connectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(connectTarget('api.anthropic.com')).toBeUndefined();
    expect(connectTarget('a:0')).toBeUndefined();
    expect(connectTarget('a:99999')).toBeUndefined();
  });

  it('tunnels an allowed host both ways, the bytes sent with the CONNECT too', async () => {
    const upstream = net.createServer((socket) => socket.on('data', (data) => socket.write(`echo ${data.toString()}`)));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const dialed: string[] = [];
    const lines: string[] = [];
    const server = createEgressProxy(['api.anthropic.com'], (line) => lines.push(line), (host, port, onConnect) => {
      dialed.push(`${host}:${port}`);
      return net.connect(upstreamPort, '127.0.0.1', onConnect);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = net.connect(port, '127.0.0.1');
      client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\nhello');
      const received = await new Promise<string>((resolve, reject) => {
        let text = '';
        client.on('data', (data) => {
          text += data.toString();
          if (text.includes('echo hello')) resolve(text);
        });
        client.on('error', reject);
      });
      client.destroy();
      expect(received).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\necho hello$/);
      expect(dialed).toEqual(['api.anthropic.com:443']);
      expect(lines).toEqual(['allow api.anthropic.com']);
    } finally {
      server.close();
      upstream.close();
    }
  });

  it('refuses a host off the list and plain HTTP, and logs both', async () => {
    const lines: string[] = [];
    const server = createEgressProxy(['api.anthropic.com'], (line) => lines.push(line));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const connect = await new Promise<number | undefined>((resolve, reject) =>
        http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'github.com:443' }).on('connect', (response, socket) => (socket.destroy(), resolve(response.statusCode))).on('error', reject).end(),
      );
      const plain = await new Promise<number | undefined>((resolve, reject) =>
        http.get({ host: '127.0.0.1', port, path: 'http://example.com/', headers: { host: 'example.com' } }, (response) => (response.resume(), resolve(response.statusCode))).on('error', reject),
      );
      expect([connect, plain]).toEqual([403, 403]);
      expect(lines).toEqual(['deny github.com:443', 'deny example.com (plain http)']);
    } finally {
      server.close();
    }
  });
});

describe('sandbox config', () => {
  it('the old `mode: docker` is rejected with the allowed values', () => {
    const home = path.join(tmpDir(), 'home');
    write(home, 'config.yaml', 'sandbox: { mode: docker }\n');
    expect(() => loadConfig({ cwd: tmpDir(), env: sandboxEnv(home) })).toThrow(/sandbox\.mode: allowed values: `container`, `none`/);
  });

  async function sandboxChecks(
    configYaml: string,
    options: {
      asked?: string[];
      image?: 'ok' | 'missing' | 'stale';
      env?: Record<string, string>;
      leftovers?: { containers: string[]; networks: string[] };
      machines?: PodmanMachine[];
    } = {},
  ) {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', configYaml);
    const checks = await runDoctor(
      { cwd: root, env: { ...sandboxEnv(home), ...options.env } },
      {
        harnessStatus: async () => ({ installed: true, version: '9.9.9' }),
        engineVersion: async (engine) => (options.asked?.push(engine), '27.1.0'),
        imageStatus: async () => options.image ?? 'ok',
        leftovers: async () => options.leftovers ?? { containers: [], networks: [] },
        podmanMachines: async () => options.machines,
        frameworkVersion: '0.1.0',
      },
    );
    return checks.filter((check) => check.name === 'sandbox');
  }

  const signedIn = { CLAUDE_CODE_OAUTH_TOKEN: 'x', CODEX_API_KEY: 'x' };

  it('doctor asks the configured engine and finds the image', async () => {
    const asked: string[] = [];
    const checks = await sandboxChecks('sandbox: { engine: docker }\n', { asked, env: signedIn });
    expect(asked).toEqual(['docker']);
    expect(checks).toEqual([{ name: 'sandbox', level: 'ok', detail: 'docker 27.1.0, image agentic/base' }]);
  });

  it('doctor: a missing image is an error, an image of another framework version a warning; both fixed by `sandbox build`', async () => {
    expect(await sandboxChecks('sandbox: { engine: docker }\n', { image: 'missing', env: signedIn })).toEqual([
      expect.objectContaining({ level: 'error', detail: 'docker 27.1.0, missing image agentic/base', fix: '`agentic sandbox build`' }),
    ]);
    expect(await sandboxChecks('sandbox: { engine: docker }\n', { image: 'stale', env: signedIn })).toEqual([
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/another framework version/) }),
    ]);
  });

  it('doctor: a running Podman machine under 4 GB is a warning (Gradle with its tests gets OOM-killed)', async () => {
    const machine = { name: 'podman-machine-default', running: true };
    expect(await sandboxChecks('sandbox: { engine: podman }\n', { env: signedIn, machines: [{ ...machine, memoryMb: 4096 }] })).toEqual([
      expect.objectContaining({ level: 'ok' }),
    ]);
    expect(await sandboxChecks('sandbox: { engine: podman }\n', { env: signedIn, machines: [{ ...machine, memoryMb: 2048 }] })).toEqual([
      expect.objectContaining({ level: 'ok' }),
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/2048 MB RAM/), fix: expect.stringContaining('podman machine set --memory 4096 podman-machine-default') }),
    ]);
  });

  it('doctor: in a JVM repo the stack layer is checked too', async () => {
    const checks = await runDoctorIn({ 'build.gradle': '' }, { 'agentic/base': 'ok', 'agentic/jvm': 'missing' });
    expect(checks).toEqual([
      expect.objectContaining({ level: 'error', detail: 'docker 27.1.0, missing image agentic/jvm', fix: '`agentic sandbox build` (in this repo also agentic/jvm)' }),
    ]);
    expect(await runDoctorIn({ 'build.gradle': '' }, { 'agentic/base': 'ok', 'agentic/jvm': 'ok' })).toEqual([
      { name: 'sandbox', level: 'ok', detail: 'docker 27.1.0, image agentic/base + agentic/jvm (stack jvm)' },
    ]);
    // the layer is checked against the base it runs on, which may be newer than the one it was built on
    expect(await runDoctorIn({ 'build.gradle': '' }, { 'agentic/base': 'ok', 'agentic/jvm on agentic/base': 'stale' })).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'docker 27.1.0, image agentic/jvm built from another framework version or on another base image' }),
    ]);
  });

  async function runDoctorIn(files: Record<string, string>, images: Record<string, 'ok' | 'missing' | 'stale'>) {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'sandbox: { engine: docker }\n');
    for (const [file, content] of Object.entries(files)) write(root, file, content);
    const checks = await runDoctor(
      { cwd: root, env: { ...sandboxEnv(home), ...signedIn } },
      {
        harnessStatus: async () => ({ installed: true, version: '9.9.9' }),
        engineVersion: async () => '27.1.0',
        imageStatus: async (_engine, image, base) => images[`${image} on ${base}`] ?? images[image] ?? 'missing',
        leftovers: async () => ({ containers: [], networks: [] }),
        frameworkVersion: '0.1.0',
      },
    );
    return checks.filter((check) => check.name === 'sandbox');
  }

  it('doctor: containers and networks left by a crashed session → `sandbox clean`', async () => {
    const checks = await sandboxChecks('sandbox: { engine: docker }\n', { env: signedIn, leftovers: { containers: ['agentic-1', 'agentic-1-egress'], networks: ['agentic-1-net'] } });
    expect(checks[1]).toEqual(expect.objectContaining({ level: 'warn', detail: 'left over from interrupted sessions: 2 containers, 1 networks', fix: '`agentic sandbox clean`' }));
  });

  it('doctor warns when a used harness has no credential for the container', async () => {
    const checks = await sandboxChecks('sandbox: { engine: docker }\n', { env: { CODEX_API_KEY: 'x' } });
    expect(checks.slice(1)).toEqual([
      expect.objectContaining({ level: 'warn', detail: expect.stringMatching(/claude in a container won't sign in/), fix: expect.stringMatching(/claude setup-token/) }),
    ]);
  });
});
