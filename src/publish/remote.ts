export interface RemoteRepo {
  host: string;
  /** `owner/repo`, or `group/subgroup/repo` on GitLab; without `.git`. */
  path: string;
}

/** `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo.git`, `https://host/owner/repo(.git)`. */
export function parseRemote(url: string): RemoteRepo | undefined {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return undefined;
    const repoPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    return repoPath.includes('/') ? { host: parsed.hostname.toLowerCase(), path: repoPath } : undefined;
  } catch {
    return undefined;
  }
}
