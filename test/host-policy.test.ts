import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config/defaults.js';
import { hostAccess, hostNetwork, SENSITIVE_PATHS } from '../src/sandbox/host-policy.js';
import { HostSandbox } from '../src/sandbox/host.js';
import { tmpDir, write } from './helpers.js';

const HOME = '/Users/dev';

describe('hostNetwork', () => {
  it('the allowlist plus the hosts of the repo’s toolchain, as in a container: a Gradle + frontend repo reaches npm and GitHub', () => {
    const repo = tmpDir();
    write(repo, 'build.gradle.kts', '');
    const sandbox = { ...DEFAULTS.sandbox, mode: 'none' as const, network: { allow: ['api.anthropic.com', '.example.com'] } };
    const hosts = hostNetwork(sandbox, repo);
    expect(hosts.slice(0, 2)).toEqual(['api.anthropic.com', '.example.com']);
    expect(hosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'services.gradle.org', 'github.com']));
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hostNetwork(sandbox, tmpDir())).not.toContain('github.com');
  });
});

describe('hostAccess', () => {
  it('closes the built-in credentials plus the configured ones', () => {
    const access = hostAccess({ read: ['~/.m2'], deny: ['~/work/secrets'] }, HOME);
    expect(access.read).toEqual(['~/.m2']);
    expect(access.deny).toEqual([...SENSITIVE_PATHS, '~/work/secrets']);
  });

  it('the defaults pass their own check', () => {
    expect(() => hostAccess(DEFAULTS.sandbox.host, HOME)).not.toThrow();
  });

  it('refuses to re-open credentials, the whole home or a relative path', () => {
    const problems = (read: string[]) => () => hostAccess({ read, deny: [] }, HOME);
    expect(problems(['~/.ssh'])).toThrow(/`~\/.ssh`: lies inside the protected `~\/.ssh`/);
    expect(problems(['~/.aws/config'])).toThrow(/lies inside the protected `~\/.aws`/);
    expect(problems(['/Users/dev/.ssh/id_ed25519'])).toThrow(/lies inside the protected `~\/.ssh`/);
    expect(problems(['~/.m2/settings.xml'])).toThrow(/protected `~\/.m2\/settings.xml`/);
    expect(problems(['~/'])).toThrow(/opens the whole home directory/);
    expect(problems(['/Users'])).toThrow(/opens the whole home directory/);
    expect(problems(['/'])).toThrow(/opens the whole home directory/);
    expect(problems(['.m2'])).toThrow(/expected an absolute path/);
    expect(problems(['~/.sshkeys-backup', '/opt/tools'])).not.toThrow();
  });

  it("closes the framework's config, not its work dir; `read` can't re-open other flows", () => {
    const access = hostAccess({ read: [], deny: [] }, HOME);
    expect(access.deny).toContain('~/.agentic/config.yaml');
    expect(access.deny).toContain('~/.agentic/trusted-checks.yaml');
    expect(access.deny.some((denied) => '~/.agentic/work/repo-1234abcd/flow/clones/g1'.startsWith(denied))).toBe(false);
    const problems = (read: string[]) => () => hostAccess({ read, deny: [] }, HOME);
    expect(problems(['~/.agentic'])).toThrow(/lies inside the protected `~\/.agentic`/);
    expect(problems(['~/.agentic/work/repo-1234abcd'])).toThrow(/lies inside the protected `~\/.agentic`/);
  });
});

describe('HostSandbox context copies', () => {
  it('the session reads fresh copies next to its out/, never the flow directory', async () => {
    const flowDir = tmpDir();
    const spec = write(flowDir, 'spec.md', 'spec v1');
    const outDir = path.join(flowDir, 'out', 'implement-g1-t1');
    fs.mkdirSync(outDir, { recursive: true });
    const workspace = { codeDir: flowDir, outDir, readOnlyMounts: [spec], network: [] };
    const sandbox = new HostSandbox();

    const copy = path.join(`${outDir}.context`, 'spec.md');
    expect(sandbox.view(workspace).readOnlyMounts).toEqual([copy]);

    write(`${outDir}.context`, 'stale.md', 'from an earlier run');
    await sandbox.exec({ argv: ['sh', '-c', `echo changed > ${copy}`] }, workspace, { interactive: false });
    expect(fs.readFileSync(spec, 'utf8')).toBe('spec v1');
    expect(fs.readdirSync(`${outDir}.context`)).toEqual(['spec.md']);

    await sandbox.exec({ argv: ['true'] }, workspace, { interactive: false });
    expect(fs.readFileSync(copy, 'utf8')).toBe('spec v1');
  });
});
