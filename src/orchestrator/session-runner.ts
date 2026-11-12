import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contractFile } from '../contracts/index.js';
import type { Executor } from '../config/types.js';
import { errorMessage } from '../errors.js';
import { readFileSafe, writeFileSafe } from '../fsutil.js';
import { COMMITTING_KINDS, type SessionKind, type SessionMode, type SessionRequest, type SessionResult } from '../harness/types.js';
import { parseReview, type Finding, type ReviewReport } from '../review/findings.js';
import { decisionIds, inactiveRules, ruleIdSet, skillSources, standardsSources, STANDARDS_DIR, type InactiveReason } from '../review/rules.js';
import { applyFrozenScope, type FrozenScope } from '../review/scope.js';
import { verifyReport, type Evidence } from '../review/verify.js';
import { collectArtifact, readArtifact } from '../sandbox/artifacts.js';
import { hostAccess, hostNetwork } from '../sandbox/host-policy.js';
import type { SessionWorkspace } from '../sandbox/types.js';
import { sessionSkills, skillDirName, skillHashes, stageSkills } from '../skills/stage.js';
import { PACKAGE_ROOT } from '../paths.js';
import { APPROVED_TICKET, ArtifactError, breakdownRules, contextArtifacts, parseMarkdown, STAGE_ARTIFACTS, validateTicket, type AssetReference } from './artifacts.js';
import { BudgetGuard } from './budget.js';
import { parseDuration, writeChecksRunner } from './checks.js';
import type { GateKeeper } from './gatekeeper.js';
import { harnessSessionsDir, rememberSessionDir } from './harness-sessions.js';
import { PROBE_URLS, type NetworkState } from './network.js';
import { buildPrompt } from './prompts.js';
import { Halt, type FlowRun } from './run.js';
import type { Pause, ScopeAxis } from './state.js';
import { appendUsage } from './usage.js';

export interface SessionScope {
  group?: string;
  task?: string;
  taskTitle?: string;
  round?: number;
  /** Tells apart sessions of the same kind in one group (`merge-g3-g2`); names its `out/` only. */
  label?: string;
  /** Acceptance criteria in scope: named in the prompt, and the spec axis must cover each. */
  acceptance?: string[];
  /** Parts of the spec's external assets the session reads before it starts; named in the prompt. */
  references?: AssetReference[];
  /** Appended to the prompt (e.g. the fixer's blocking findings). */
  extra?: string;
  /** Where the session runs; defaults to the group's clone, outside a group to the origin repo. */
  cwd?: string;
  /** More flow files (names in the flow directory) the session reads, mounted read-only after the stage's artifacts. */
  flowFiles?: string[];
  /** Continues this earlier session with `extra` as the next message; its `out/` is kept. */
  resume?: string;
  /** Numbers the resumed run of a session (2, 3, …), so its transcript doesn't replace the earlier one. */
  attempt?: number;
  /** A missing contract artifact comes back as `artifact: undefined` for the caller to handle (a resumed session). */
  missingArtifactOk?: boolean;
  /** The commands the orchestrator verifies the session's work with, named in the prompt. */
  checks?: string[];
}

/** `<kind>[-<group>][-r<round>].json` — a review report kept next to the flow. */
export function reportName(kind: SessionKind, group?: string, round?: number): string {
  return `${[kind, group, round && `r${round}`].filter(Boolean).join('-')}.json`;
}

/**
 * A finished session and the JSON it reported, for stages with a JSON contract (contracts/index.ts);
 * its `out/` on the host and as the agent sees it (a resumed session keeps it).
 */
export type SessionOutcome = SessionResult & {
  artifact?: string;
  outDir: string;
  agentOutDir: string;
  /** Interactive: the session wrote `.done` — the human confirmed its artifact, not left it with Ctrl+C or `/exit`. */
  confirmed?: boolean;
};

const TICKET_TEMPLATE = path.join('.agentic', 'templates', 'ticket.md');
/** Written by an interactive session once the human confirmed its artifact; the orchestrator then closes it. */
const DONE_FILE = '.done';

/** Sessions that build and test the code: the test author, implementer, fixer, merge and the reviewers. */
const TRUSTED_KINDS: SessionKind[] = [...COMMITTING_KINDS, 'review-spec', 'review-standards', 'review-security', 'review-final'];

/** The next message of a resumed session: what the orchestrator found, and the artifact to update. */
function resumePrompt(kind: SessionKind, problems: string, outDir: string): string {
  if (kind === 'grill-business' || kind === 'grill-technical') {
    return [
      'The session ended before its artifacts were ready, and the human chose to continue this conversation:',
      '',
      problems,
      '',
      `Everything settled so far still holds. Tell the human in one or two sentences where you stopped, then continue from there; write the artifacts to \`${outDir}\` as before.`,
    ].join('\n');
  }
  const reviewer = kind.startsWith('review-');
  return [
    `The orchestrator checked your ${reviewer ? 'report' : 'work'} after the session and it is not done yet:`,
    '',
    problems,
    '',
    reviewer
      ? `Update your report in \`${outDir}\`. Do not change the code.`
      : `Fix this, commit, and update your report in \`${outDir}\` if anything in it changed. Do not amend, rebase or reset commits.`,
  ].join('\n');
}

/** Asks a reviewer to lengthen quotes that match more than one place near their line. */
function longerQuotes(findings: Finding[]): string {
  return [
    'These quotes match more than one place near their line, so the finding could point at either. Quote more of the code',
    '(e.g. the line before or after) so each matches one place, verbatim. Keep everything else in the report.',
    ...findings.map((finding) => `- ${finding.id} ${finding.file}:${finding.line}: ${JSON.stringify(finding.quote)}`),
  ].join('\n');
}

/** Open findings of the previous round the reviewer gave no verdict on. */
function missingVerdicts(report: ReviewReport, frozen: FrozenScope): string[] {
  const judged = new Set((report.previous ?? []).map((verdict) => verdict.id));
  return frozen.previous.filter((finding) => !judged.has(finding.id!)).map((finding) => finding.id!);
}

function askVerdicts(ids: string[]): string {
  return `Your report has no verdict in \`previous\` for ${ids.join(', ')}: give each one \`fixed\` or \`not_fixed\`. Keep everything else in the report.`;
}

/** Waits before each retry of a transient failure: three, backing off. */
export const TRANSIENT_RETRY_DELAYS_MS = [1500, 5000, 15_000];
/** With the host offline, the probe runs this often, for at most `NETWORK_MAX_WAIT_MS`; then the flow pauses. */
export const NETWORK_POLL_MS = 60_000;
export const NETWORK_MAX_WAIT_MS = 30 * 60_000;
/** `on_rate_limit: wait` waits at most this long in all (a subscription's window is five hours), then pauses. */
export const RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 60_000;
/** Without a reset time from the harness, it looks again after this long. */
export const RATE_LIMIT_POLL_MS = 15 * 60_000;

/** What the host's probe adds to a transient failure's pause: an outage is not the session's error. */
function networkNote(network: { state: NetworkState; url?: string } | undefined): string {
  if (network?.state === 'down') return `\n  the host can't reach ${network.url} for ${NETWORK_MAX_WAIT_MS / 60_000} min; network down? \`agentic resume\` when it is back`;
  if (network?.state === 'tls') {
    return `\n  the host doesn't trust the ${network.url} certificate either: a network failure (router, captive portal) or TLS inspection without a trusted CA; check the connection and \`agentic resume\``;
  }
  return '';
}

/** Until the limit lifts (and a minute more), else a poll. */
export function rateLimitDelay(resetsAt: number | undefined, now: number): number {
  return resetsAt && resetsAt > now ? resetsAt - now + 60_000 : RATE_LIMIT_POLL_MS;
}

const INTERRUPTED_PROMPT =
  'Your previous run was interrupted (an API error or a rate limit), not by anything you did. Continue the task where you left off; everything asked before still holds.';

/**
 * The next run after a failure: the session resumed when the agent had started, else run again — a resumed
 * session with the same message, a fresh one under a new id.
 */
function retryRequest(request: SessionRequest, failed: SessionResult): SessionRequest {
  if (failed.startedWork && failed.sessionId) return { ...request, resumeSessionId: failed.sessionId, prompt: INTERRUPTED_PROMPT };
  return request.resumeSessionId ? request : { ...request, sessionId: randomUUID() };
}

/** The first line of what a failed session said; a session that died silently (smoke 92-5) gets its exit code. */
function failureReason(result: SessionResult): string {
  return result.output.split('\n')[0]!.trim() || `session stopped without a message (code ${result.exitCode})`;
}

/** `<kind>[-<group>][-<task>][-r<round>]` — names the session's `out/` directory. */
function sessionName(kind: SessionKind, scope: SessionScope): string {
  return [kind, scope.group, scope.task, scope.round && `r${scope.round}`, scope.label].filter(Boolean).join('-');
}

/**
 * One agent session: the harness builds the command, the sandbox runs it, artifacts come back from
 * the session's `out/`. Also the usage record, events, rate limit and exit code.
 * Problems surface as `Halt`, scoped to the session's group when it has one.
 */
export class SessionRunner {
  private readonly budget?: BudgetGuard;

  /** Without a gatekeeper (no one to ask) the budget isn't checked. */
  constructor(
    private readonly flow: FlowRun,
    gatekeeper?: GateKeeper,
  ) {
    if (gatekeeper) this.budget = new BudgetGuard(flow, gatekeeper);
  }

  private sleep(ms: number): Promise<void> {
    return this.flow.context.sleep ? this.flow.context.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * After the quick retries, whether the host reaches the harness's API: offline it probes every minute until the
   * network is back (`recovered`: worth another round of retries) or `NETWORK_MAX_WAIT_MS` passes (acceptance smoke,
   * finding 6: an outage looked like a certificate error and paused within 20 s).
   */
  private async awaitNetwork(harness: string, who: string): Promise<{ state: NetworkState; url?: string; recovered?: boolean }> {
    const url = PROBE_URLS[harness];
    const { probe } = this.flow.context;
    if (!url || !probe) return { state: 'up' };
    let state = await probe(url);
    if (state !== 'down') return { state, url };
    this.flow.log(`! ${who}: the host can't reach ${url}; network down? Checking every ${NETWORK_POLL_MS / 60_000} min, at most ${NETWORK_MAX_WAIT_MS / 60_000} min`);
    for (let waitedMs = 0; state === 'down' && waitedMs < NETWORK_MAX_WAIT_MS; waitedMs += NETWORK_POLL_MS) {
      await this.sleep(NETWORK_POLL_MS);
      state = await probe(url);
    }
    if (state === 'down') return { state, url };
    this.flow.log(`✓ ${who}: ${url} answers again; retrying the session`);
    return { state, url, recovered: true };
  }

  async run(kind: SessionKind, mode: SessionMode, executor: Executor, scope: SessionScope = {}): Promise<SessionOutcome> {
    this.flow.checkNotStopped(scope.group);
    await this.budget?.check(scope.group);
    const { context, state } = this.flow;
    const stage = state.stage;
    const notes = state.notes.filter((note) => note.stage === stage && (!scope.group || note.group === scope.group)).map((note) => note.note);
    const name = sessionName(kind, scope);
    const skills = sessionSkills(this.flow.context.config, kind);
    const { workspace, mounts, hashes } = this.workspace(kind, name, scope, skills);
    const harness = context.harnesses[executor.harness];
    if (context.sandbox.isolated && harness.sessionsHome) {
      workspace.harnessSessions = { hostDir: harnessSessionsDir(context.workDir, executor.harness, scope.resume), sessionsHome: harness.sessionsHome };
    }
    this.flow.log(`→ ${kind}${scope.group ? ` ${scope.group}` : ''}${scope.task ? `/${scope.task}` : ''} [${executor.harness}:${executor.model}/${executor.effort}]`);
    const sessionScope = { kind, group: scope.group, task: scope.task, round: scope.round };
    this.flow.emit({ type: 'session_started', ...sessionScope, harness: executor.harness, model: executor.model, effort: executor.effort });
    const view = context.sandbox.view(workspace);
    const agentPath = (index: number | undefined) => (index === undefined ? undefined : view.readOnlyMounts[index]);
    const skillsDir = agentPath(mounts.skills)!;
    const checksRunner = this.checksRunner(kind, name, workspace);
    const request: SessionRequest = {
      kind,
      mode,
      executor,
      cwd: view.codeDir,
      outDir: view.outDir,
      contextFiles: view.readOnlyMounts,
      prompt: scope.resume ? resumePrompt(kind, scope.extra ?? '', view.outDir) : buildPrompt(kind, {
        title: state.title,
        mode,
        outDir: view.outDir,
        ...(mode === 'interactive' && view.outDir !== workspace.outDir && { hostOutDir: workspace.outDir }),
        doneFile: path.posix.join(view.outDir, DONE_FILE),
        contextFiles: view.readOnlyMounts.slice(0, mounts.files),
        skills: skills.map((skill) => path.posix.join(skillsDir, skillDirName(skill), 'SKILL.md')),
        standards: this.standards(workspace.codeDir),
        inactiveRules: this.inactiveRules(kind, workspace.codeDir),
        ticketTemplate: agentPath(mounts.template),
        language: context.config.language,
        ...(kind === 'breakdown' && { breakdownRules: breakdownRules(context.config) }),
        notes,
        ...scope,
        checksRunner,
      }),
      skills,
      group: scope.group,
      task: scope.task,
      acceptance: scope.acceptance,
      sessionId: randomUUID(),
      ...(scope.resume && { resumeSessionId: scope.resume }),
      isolated: context.sandbox.isolated,
      hostAccess: context.sandbox.isolated ? undefined : hostAccess(context.config.sandbox.host),
      ...(!context.sandbox.isolated && { network: hostNetwork(context.config.sandbox, state.origin.repoRoot) }),
      ...(workspace.harnessSessions && { sessionsDir: workspace.harnessSessions.hostDir }),
      ...(checksRunner && { checksRunner }),
    };
    const transcripts = path.join(context.workDir, 'transcripts');
    const attempt = scope.attempt && scope.attempt > 1 ? `-a${scope.attempt}` : '';
    const transcriptFile = (sessionId: string, retry: number) => path.join(transcripts, `${name}${attempt}${retry ? `-retry${retry}` : ''}-${sessionId}.jsonl`);
    const interactive = mode === 'interactive';
    const runOnce = async (runRequest: SessionRequest, retry: number): Promise<SessionResult> => {
      // headless, the stream lands in transcripts/ as it comes (`tail -f`); named by our id until the harness reports its own
      const liveTranscript = interactive ? undefined : transcriptFile(runRequest.resumeSessionId ?? runRequest.sessionId, retry);
      const recordUsage = (result: SessionResult) => {
        // the harness's id names a file — anything unexpected falls back to ours
        const sessionId = result.sessionId && /^[\w-]{1,100}$/.test(result.sessionId) ? result.sessionId : runRequest.sessionId;
        if (liveTranscript && fs.existsSync(liveTranscript)) {
          if (liveTranscript !== transcriptFile(sessionId, retry)) fs.renameSync(liveTranscript, transcriptFile(sessionId, retry));
        } else if (result.transcript) {
          fs.mkdirSync(transcripts, { recursive: true });
          writeFileSafe(transcriptFile(sessionId, retry), result.transcript);
        }
        if (workspace.harnessSessions) rememberSessionDir(workspace.harnessSessions.hostDir, sessionId);
        appendUsage(context.workDir, { stage, ...sessionScope, executor, result, sessionId, skills: runRequest.skills, skillHashes: hashes });
        this.flow.emit({ type: 'session_done', ...sessionScope, session_id: sessionId, exit_code: result.exitCode, duration_ms: result.durationMs });
      };
      const startedAt = Date.now();
      let result: SessionResult;
      try {
        const command = harness.buildCommand(runRequest);
        const execOptions = interactive
          ? { interactive, doneFile: path.join(workspace.outDir, DONE_FILE) }
          : { interactive, liveOutput: liveTranscript, timeoutMs: parseDuration(context.config.session_timeout) };
        result = harness.parseResult(await context.sandbox.exec(command, workspace, execOptions), runRequest);
        if (!result.usage || result.usagePartial) {
          const usage = harness.sessionUsage?.(runRequest, startedAt);
          if (usage) result = { ...result, usage };
        }
      } catch (error) {
        // the session may have spent minutes (and tokens the harness never reported) before crashing
        recordUsage({ exitCode: -1, output: errorMessage(error), durationMs: Date.now() - startedAt });
        throw error;
      }
      recordUsage(result);
      return result;
    };
    const { result, retries, working, network } = interactive
      ? { result: await runOnce(request, 0), retries: 0, working: undefined }
      : await this.retrying(request, runOnce, { kind, group: scope.group, harness: executor.harness });
    // stopped midway, not failed on its own: the session is worth resuming later
    const interrupted = (halt: Halt) => Object.assign(halt, working ? { session: working } : {});
    if (result.rateLimited) {
      this.flow.emit({ type: 'rate_limited', harness: executor.harness, group: scope.group });
      const pause: Pause = { reason: 'rate_limit', group: scope.group, message: `rate limit (${executor.harness})` };
      throw interrupted(new Halt(context.profile.on_rate_limit === 'fail' ? 'failed' : 'paused', pause));
    }
    if (!interactive && result.timedOut) {
      throw interrupted(
        new Halt('paused', { reason: 'timeout', group: scope.group, message: `${kind} went over \`session_timeout\` (${context.config.session_timeout}) and was stopped` }),
      );
    }
    if (!interactive && result.transient) {
      throw interrupted(
        new Halt('paused', {
          reason: 'error',
          group: scope.group,
          message: `${kind}: transient error, ${retries} retries did not help; last: ${failureReason(result).slice(0, 500)}${networkNote(network)}`,
        }),
      );
    }
    if (mode === 'headless' && result.exitCode !== 0) {
      // a session that worked before failing leaves its changes behind: resume continues it, not a fresh one
      throw interrupted(
        new Halt('paused', {
          reason: 'error',
          group: scope.group,
          message: `${kind} exited with code ${result.exitCode}${result.output ? `: ${result.output.slice(0, 500)}` : ''}`,
        }),
      );
    }
    for (const artifact of STAGE_ARTIFACTS[kind] ?? []) collectArtifact(workspace.outDir, artifact, context.workDir);
    const outcome: SessionOutcome = {
      ...result,
      outDir: workspace.outDir,
      agentOutDir: view.outDir,
      ...(interactive && { confirmed: fs.existsSync(path.join(workspace.outDir, DONE_FILE)) }),
    };
    const file = contractFile(kind);
    if (!file) return outcome;
    const artifact = readArtifact(workspace.outDir, file);
    if (artifact === undefined) {
      if (scope.missingArtifactOk) return outcome;
      throw new ArtifactError(file, [`session ${name} did not write ${file} in out/`]);
    }
    // reviews keep their parsed report instead (`review`)
    if (!kind.startsWith('review-')) writeFileSafe(path.join(context.workDir, `${name}.json`), artifact);
    return { ...outcome, artifact };
  }

  /**
   * A headless session, run again while its failure is worth it: a transient error (a few times, backing off) and,
   * with `on_rate_limit: wait`, a rate limit. A retry costs like any session, so it checks the budget first.
   * Returns the last result, the transient retries made and the session that got to work — even if a later retry
   * of it died before answering.
   */
  private async retrying(
    request: SessionRequest,
    runOnce: (request: SessionRequest, retry: number) => Promise<SessionResult>,
    session: { kind: SessionKind; group?: string; harness: string },
  ): Promise<{ result: SessionResult; retries: number; working?: string; network?: { state: NetworkState; url?: string } }> {
    const { kind, group, harness } = session;
    const who = `${kind}${group ? ` ${group}` : ''}`;
    let result = await runOnce(request, 0);
    let working = result.startedWork ? result.sessionId : undefined;
    let retries = 0;
    let network: { state: NetworkState; url?: string; recovered?: boolean } | undefined;
    for (let retry = 1, waitedMs = 0; ; retry++) {
      if (result.transient && retries < TRANSIENT_RETRY_DELAYS_MS.length) {
        const delay = TRANSIENT_RETRY_DELAYS_MS[retries++]!;
        this.flow.log(`! ${who}: transient error (${failureReason(result).slice(0, 120)}); retrying in ${delay / 1000} s (${retries}/${TRANSIENT_RETRY_DELAYS_MS.length})`);
        await this.sleep(delay);
      } else if (result.transient && !network) {
        // once per session: back online, the retries start over
        network = await this.awaitNetwork(harness, who);
        if (!network.recovered) break;
        retries = 0;
      } else if (result.rateLimited && this.flow.context.profile.on_rate_limit === 'wait') {
        const delay = rateLimitDelay(result.rateLimitResetsAt, Date.now());
        if (waitedMs + delay > RATE_LIMIT_MAX_WAIT_MS) break;
        waitedMs += delay;
        this.flow.emit({ type: 'rate_limited', harness, group });
        this.flow.log(`! rate limit (${harness}); waiting until ${new Date(Date.now() + delay).toTimeString().slice(0, 5)}`);
        await this.sleep(delay);
      } else {
        break;
      }
      // past the budget a human decides before the retry; a stop keeps the session to resume
      await this.budget?.check(group).catch((error: unknown) => {
        if (error instanceof Halt && working) error.session = working;
        throw error;
      });
      result = await runOnce(retryRequest(request, result), retry);
      if (result.startedWork) working = result.sessionId;
    }
    return { result, retries, working, ...(network && { network }) };
  }

  /**
   * A fresh, empty `out/` per session, so nothing left from an earlier run passes for its result.
   * Read-only mounts, in order: flow artifacts (`mounts.files` of them), the ticket template, the staged skills.
   */
  private workspace(
    kind: SessionKind,
    name: string,
    scope: SessionScope,
    skills: string[],
  ): { workspace: SessionWorkspace; mounts: { files: number; template?: number; skills: number }; hashes: Record<string, string> } {
    const { context, state } = this.flow;
    const outDir = path.join(context.workDir, 'out', name);
    // a resumed session continues its own `out/`
    if (!scope.resume) fs.rmSync(outDir, { recursive: true, force: true });
    // a done file left by the earlier run would close the resumed interactive session at once
    else fs.rmSync(path.join(outDir, DONE_FILE), { force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const readOnlyMounts = [...contextArtifacts(kind), ...(scope.flowFiles ?? []).map((name) => [name])].flatMap((candidates) => {
      const present = candidates.map((name) => path.join(context.workDir, name)).find((file) => fs.existsSync(file));
      return present ? [present] : [];
    });
    const files = readOnlyMounts.length;
    const template = kind === 'grill-business' ? readOnlyMounts.push(this.stageTicketTemplate(name)) - 1 : undefined;
    const skillsDir = path.join(context.workDir, 'out', `${name}.skills`);
    stageSkills(skillsDir, skills, state.origin.repoRoot);
    const skillsIndex = readOnlyMounts.push(skillsDir) - 1;
    const codeDir = scope.cwd ?? ((scope.group && state.groups[scope.group]?.clonePath) || state.origin.repoRoot);
    const workspace: SessionWorkspace = {
      codeDir,
      outDir,
      readOnlyMounts,
      network: context.config.sandbox.network.allow,
      // the human's repo, before there are clones (grills, breakdown): a session that wrote it, `.git` included, would reach the host
      ...(codeDir === state.origin.repoRoot && { codeReadOnly: true }),
    };
    return { workspace, mounts: { files, template, skills: skillsIndex }, hashes: skillHashes(skillsDir, skills) };
  }

  /**
   * On the host, sessions that build and test (`TRUSTED_KINDS`) in a clone get `run-checks` once the human
   * allowed this repo's checks; in a container the agent runs the commands itself.
   */
  private checksRunner(kind: SessionKind, name: string, workspace: SessionWorkspace): string | undefined {
    const { context, state } = this.flow;
    const commands = context.config.review.checks;
    if (context.sandbox.isolated || !context.checksTrusted || !TRUSTED_KINDS.includes(kind) || commands === 'none' || !commands.length) return undefined;
    if (workspace.codeDir === state.origin.repoRoot) return undefined;
    return writeChecksRunner(this.flow, { name, cwd: workspace.codeDir, outDir: workspace.outDir, commands });
  }

  /**
   * The repo's own template, else the framework's, copied under a name that can't collide with the flow's
   * `ticket.md` among the mounts. TODO: the workspace's template between the two.
   */
  private stageTicketTemplate(name: string): string {
    const repoTemplate = path.join(this.flow.state.origin.repoRoot, TICKET_TEMPLATE);
    const source = fs.existsSync(repoTemplate) ? repoTemplate : path.join(PACKAGE_ROOT, 'templates', 'ticket.md');
    const staged = path.join(this.flow.context.workDir, 'out', `${name}.template`, 'ticket-template.md');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, readFileSafe(source, source));
    return staged;
  }

  /** Markdown files in the working directory's `.agentic/standards/`, as paths relative to it. */
  private standards(codeDir: string): string[] {
    const dir = path.join(codeDir, STANDARDS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort()
      .map((file) => path.posix.join('.agentic', 'standards', file));
  }

  /**
   * A review session, its blocking findings verified (`verifyReport`); the report is kept next to the flow (`reportName`).
   * Ambiguous quotes get one resume of the same session; still ambiguous, they are rejected.
   * In round 2+ the frozen scope applies last (`applyFrozenScope`).
   */
  async review(
    axis: ScopeAxis,
    executor: Executor,
    scope: Pick<SessionScope, 'group' | 'round' | 'cwd' | 'acceptance' | 'references' | 'flowFiles' | 'extra'> & { frozen?: FrozenScope },
    read: Evidence['read'],
  ): Promise<ReviewReport> {
    const kind = `review-${axis}` as const;
    const evidence = this.evidence(kind, scope.cwd, read);
    const { frozen: _frozen, ...sessionScope } = scope;
    const first = await this.run(kind, 'headless', executor, sessionScope);
    let verification = await verifyReport(parseReview(first.artifact!, axis, scope.acceptance), evidence, { lastAttempt: !first.sessionId });
    const label = `${kind}${scope.group ? ` ${scope.group}` : ''}`;
    let session = first;
    if (verification.ambiguous.length) {
      this.flow.log(`! ${label}: ambiguous quotes (${verification.ambiguous.map((finding) => finding.id).join(', ')}); resuming the reviewer`);
      session = await this.run(kind, 'headless', executor, { ...sessionScope, resume: first.sessionId, attempt: 2, extra: longerQuotes(verification.ambiguous) });
      verification = await verifyReport(parseReview(session.artifact!, axis, scope.acceptance), evidence, { lastAttempt: true });
    }
    // a finding left without a verdict would count as not fixed: one resume asks for it
    const unjudged = scope.frozen ? missingVerdicts(verification.report, scope.frozen) : [];
    if (unjudged.length && session.sessionId) {
      this.flow.log(`! ${label}: no verdict for ${unjudged.join(', ')}; resuming the reviewer`);
      session = await this.run(kind, 'headless', executor, { ...sessionScope, resume: session.sessionId, attempt: session === first ? 2 : 3, extra: askVerdicts(unjudged) });
      verification = await verifyReport(parseReview(session.artifact!, axis, scope.acceptance), evidence, { lastAttempt: true });
    }
    const report = scope.frozen ? applyFrozenScope(verification.report, verification.report.previous ?? [], scope.frozen) : verification.report;
    writeFileSafe(path.join(this.flow.context.workDir, reportName(kind, scope.group, scope.round)), JSON.stringify(report, null, 2) + '\n');
    return report;
  }

  /** What the findings are checked against: the ticket's ACs, the spec's headings, the rules of the standards and skills, the ADRs. */
  private evidence(kind: SessionKind, cwd: string | undefined, read: Evidence['read']): Evidence {
    const { context, state } = this.flow;
    const ticketFile = fs.existsSync(path.join(context.workDir, APPROVED_TICKET)) ? APPROVED_TICKET : 'ticket.md';
    const specFile = path.join(context.workDir, 'spec.md');
    const specSections = fs.existsSync(specFile)
      ? [...parseMarkdown(fs.readFileSync(specFile, 'utf8')).body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => heading[1]!.trim())
      : undefined;
    const rules = this.ruleSources(kind, cwd ?? state.origin.repoRoot);
    const inactive = inactiveRules(context.config, rules);
    const ruleIds = new Set([...ruleIdSet(rules), ...decisionIds(cwd ?? state.origin.repoRoot)].filter((id) => !inactive.has(id)));
    return { acceptance: validateTicket(this.flow.read(ticketFile)).acceptance, specSections, ruleIds, inactiveRules: inactive, read };
  }

  /** The repo standards and the session's skills: where its rules are defined. */
  private ruleSources(kind: SessionKind, codeDir: string) {
    return [...standardsSources(codeDir), ...skillSources(sessionSkills(this.flow.context.config, kind), this.flow.state.origin.repoRoot)];
  }

  /** `AG-CODE-03 (rules.disabled)` for each rule of the session the agent must neither apply nor cite. */
  private inactiveRules(kind: SessionKind, codeDir: string): string[] {
    const inactive: Map<string, InactiveReason> = inactiveRules(this.flow.context.config, this.ruleSources(kind, codeDir));
    return [...inactive].map(([id, reason]) => `${id} (${reason})`);
  }

}
