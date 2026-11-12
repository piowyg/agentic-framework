import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import type { Profile } from './types.js';

export interface ProfileMatch {
  name?: string;
  profile: Profile;
  reason: 'remote' | 'path' | 'default' | 'none';
}

/** First profile (declaration order) matching remote or path, else `default_profile`. */
export function resolveProfile(
  profiles: Record<string, Profile>,
  defaultProfile: string | undefined,
  context: { remote?: string; path?: string },
): ProfileMatch {
  for (const [name, profile] of Object.entries(profiles)) {
    const match = profile.match;
    if (match?.remote && context.remote && wildcard(match.remote).test(context.remote)) return { name, profile, reason: 'remote' };
    if (match?.path && context.path && pathMatches(match.path, context.path)) return { name, profile, reason: 'path' };
  }
  if (defaultProfile) {
    const profile = profiles[defaultProfile];
    if (!profile) throw new Error(`default_profile: profile \`${defaultProfile}\` does not exist`);
    return { name: defaultProfile, profile, reason: 'default' };
  }
  return { profile: {}, reason: 'none' };
}

export function expandHome(filePath: string): string {
  return filePath === '~' || filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

function pathMatches(glob: string, target: string): boolean {
  const pattern = expandHome(glob);
  const resolved = path.resolve(target);
  return picomatch.isMatch(resolved, pattern, { dot: true }) || picomatch.isMatch(resolved + '/', pattern, { dot: true });
}

/** `*` matches anything, including `/` and `:`. */
function wildcard(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
