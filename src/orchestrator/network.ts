import { execFile } from 'node:child_process';

/** What the host gets from a harness's API: any HTTP answer, no connection, or a TLS certificate it doesn't trust. */
export type NetworkState = 'up' | 'down' | 'tls';

/** The API each harness talks to; a host that can't reach it can't run its sessions either. */
export const PROBE_URLS: Record<string, string> = {
  claude: 'https://api.anthropic.com',
  codex: 'https://api.openai.com',
};

/** curl's exit codes for a certificate or TLS handshake the host rejects. */
const TLS_EXIT_CODES = new Set([35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91]);
/** Any HTTP answer: 0, or 22 for an error status. */
const ANSWERED_EXIT_CODES = new Set([0, 22]);

/**
 * Asks `url` from the host with curl, which honours the proxy variables like the harnesses do. Without curl there is
 * nothing to tell: `up`, so a failure is handled as before.
 */
export function probeNetwork(url: string): Promise<NetworkState> {
  return new Promise((resolve) => {
    execFile('curl', ['--silent', '--head', '--output', '/dev/null', '--max-time', '10', url], (error) => {
      if (!error) return resolve('up');
      const code = typeof error.code === 'number' ? error.code : undefined;
      if (code === undefined || ANSWERED_EXIT_CODES.has(code)) return resolve('up');
      resolve(TLS_EXIT_CODES.has(code) ? 'tls' : 'down');
    });
  });
}
