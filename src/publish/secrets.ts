import { execFile } from 'node:child_process';
import { gitEnv } from '../config/git.js';

export interface SecretLeak {
  rule: string;
  file: string;
  line: number;
  commit: string;
}

export type SecretScan = (repoPath: string, range: string) => Promise<SecretLeak[]>;

export const GITLEAKS_FIX = '`brew install gitleaks` (macOS) or https://github.com/gitleaks/gitleaks#installing';

interface GitleaksFinding {
  RuleID: string;
  File: string;
  StartLine: number;
  Commit: string;
}

/**
 * gitleaks over the flow's commits only (`<base>..<head>`), secrets redacted. Every commit there is an agent's,
 * so `gitleaks:allow` comments don't count: an agent could have written them. A missing gitleaks stops `publish`.
 */
export const gitleaks: SecretScan = (repoPath, range) =>
  new Promise((resolve, reject) => {
    const args = ['git', `--log-opts=${range}`, '--no-banner', '--redact', '--ignore-gitleaks-allow', '--report-format=json', '--report-path=-', '--log-level=error', '.'];
    execFile('gitleaks', args, { cwd: repoPath, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: number | string }) | null)?.code;
      if (code === 'ENOENT') return reject(new Error(`publish needs gitleaks (secret scan before the push): ${GITLEAKS_FIX}`));
      if (error && code !== 1) return reject(new Error(`gitleaks: ${(stderr || error.message).trim().slice(-500)}`));
      try {
        const findings = JSON.parse(stdout || '[]') as GitleaksFinding[];
        resolve(findings.map((finding) => ({ rule: finding.RuleID, file: finding.File, line: finding.StartLine, commit: finding.Commit })));
      } catch {
        reject(new Error(`gitleaks: unreadable report: ${stdout.slice(0, 200)}`));
      }
    });
  });
