import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from '../config/git.js';
import { stackLayout } from '../publish/stack.js';
import type { ChainSource } from './branch-chain.js';
import { checksFailingLimit } from './clone-work.js';
import type { GateKeeper } from './gatekeeper.js';
import { AGENTIC_IDENTITY, isAncestor, SAFE_GIT } from './repos.js';
import { rebuildBranches, removeClones, removeRestackRefs, type RebuiltBranch, type RestackSource } from './restack-rebase.js';
import { Halt, type FlowRun } from './run.js';
import type { SessionRunner } from './session-runner.js';
import type { FinalSplitState } from './state.js';
import { refreeze, testBlobs } from './write-tests.js';

/** One hunk of a fix commit (`git diff -U0`), positions as git prints them. */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The `@@` line and the changed lines, as `git apply` takes them. */
  text: string;
}

/** A piece of a fix commit that goes to one group: a hunk, or a whole file (new, binary, renamed, mode change). */
export type FixPart = { path: string; group: string; why?: string } & ({ hunk: Hunk; header: string } | { whole: true });

export interface FixAssignment {
  commit: string;
  parts: FixPart[];
}

/** Lines of the tree difference a stop at the end of the rebuild shows. */
const TREE_DIFF_LINES = 80;

/** What a `merge` session is told when its resolution changed the fixes; only the latest attempt's difference is kept. */
const TREE_DIFF_NOTE =
  "The rebuilt stack must end with exactly the final review's code, but it came out different: `git diff <rebuilt top> <final review>` shows what your resolution lost or added:";

/**
 * The final review's fixes moved into the stack's groups whose lines they touch (design: pr-stack, 3c), at the end of
 * the `final-review` stage, after the `final` gate, before publish. Each fix commit is split into hunks and `git blame`
 * says whose line each one changes (0 tokens); per group a commit `(final review)` carries its part, and the stack is
 * rebuilt bottom up (`rebuildBranches`, as `restack` does), conflicts through a `merge` session and the `merge` gate.
 * Lines of several groups, from before the feature, new files and anything unclear stay on the top PR. The top
 * group's tree must come out equal to the final review's. Red checks on a lower group send its fixes back to the top,
 * or, when it has none, those of the nearest group under it that has some; then the stack is rebuilt again.
 */
export class FinalSplit {
  constructor(
    private readonly flow: FlowRun,
    private readonly gatekeeper: GateKeeper,
    private readonly sessions: SessionRunner,
  ) {}

  private get split(): FinalSplitState {
    return ((this.flow.state.final_review ??= {}).split ??= {});
  }

  /** `stack`: the origin repo's groups in plan order with their heads; `base`: where the first one starts. */
  async run(stack: ChainSource[], base: string | undefined): Promise<void> {
    const { flow } = this;
    const { state } = flow;
    const split = this.split;
    if (split.done) return;
    const finalHead = state.final_review?.head ?? state.final_review?.baseRef;
    const repo = state.origin.repoRoot;
    if (!flow.context.config.publish.stack || stack.length < 2 || !finalHead || !base) return this.keep();
    const layout = stackLayout({
      groups: stack.map((source) => source.group),
      heads: Object.fromEntries(stack.map((source) => [source.group.id, source.head])),
      featureHead: finalHead,
      isAncestor: (ancestor, descendant) => isAncestor(repo, ancestor, descendant),
    });
    if (layout.groups.length < 2) return this.keep(layout.reason);
    const top = stack.at(-1)!;
    const fixes = git(repo, ['rev-list', '--reverse', '--parents', `${top.head}..${finalHead}`]).split('\n').filter(Boolean);
    if (!fixes.length) return this.keep();
    if (fixes.some((line) => line.split(' ').length > 2)) return this.keep('the final review has merge commits');
    const owners = groupCommits(repo, base, stack);
    const assignment = assignFixes(repo, fixes.map((line) => line.split(' ')[0]!), owners, top.group.id);
    if (!assignment.some((fix) => fix.parts.some((part) => part.group !== top.group.id))) {
      flow.log('The final review fixes touch only the last group; they stay in the last PR.');
      return this.keep();
    }
    for (const fix of assignment) {
      for (const part of fix.parts) flow.log(`  ${fix.commit.slice(0, 12)} ${describePlace(part)} → ${part.group}${part.why ? ` (${part.why})` : ''}`);
    }
    const limit = checksFailingLimit(flow.context.config.review.stop_on);
    for (;;) {
      const withdrawn = split.withdrawn ?? {};
      const effective = assignment.map((fix) => ({
        ...fix,
        parts: fix.parts.map((part) => {
          const redOn = withdrawn[part.group];
          return redOn ? { ...part, group: top.group.id, why: `checks red on ${redOn}` } : part;
        }),
      }));
      // the original fix commits stay on the top PR as the final review made them
      if (!effective.some((fix) => fix.parts.some((part) => part.group !== top.group.id))) return this.keep();
      const picksByGroup = Object.fromEntries(stack.map((source) => [source.group.id, fixCommits(flow, repo, effective, source.group.id)]));
      const branches: RestackSource[] = stack.map((source, index) => ({
        group: source.group.id,
        branch: state.groups[source.group.id]?.branch ?? source.group.id,
        upstream: index ? stack[index - 1]!.head : base,
        remoteHead: source.head,
        picks: picksByGroup[source.group.id]!,
      }));
      const results = await rebuildBranches(flow, this.gatekeeper, this.sessions, {
        purpose: 'final-fixes',
        repo,
        base: state.target?.branch ?? base.slice(0, 12),
        onto: base,
        branches,
        retry: `agentic resume ${state.slug}`,
      });
      const redIndex = results.findIndex((result) => result.red);
      if (redIndex >= 0) {
        const redOn = stack[redIndex]!.group.id;
        const red = results[redIndex]!.red!;
        // the red group's own fixes, or else the nearest group under it that still carries some: one withdrawal per rebuild
        const culprit = stack
          .slice(0, redIndex + 1)
          .reverse()
          .find((source) => source.group.id !== top.group.id && picksByGroup[source.group.id]!.length)?.group.id;
        if (!culprit) return this.keep(`checks red on branch ${redOn}, and there are no fixes left below it to withdraw:\n${red}`);
        flow.log(`! the final review fixes of group ${culprit} go back to the last PR: checks red with them on branch ${redOn}:\n${red}`);
        split.withdrawn = { ...withdrawn, [culprit]: redOn };
        flow.save();
        continue;
      }
      const topHead = results.at(-1)!.head;
      if (treeOf(repo, topHead) === treeOf(repo, finalHead)) return this.apply(stack, results, effective, finalHead, top.group.id);
      const entries = state.final_review?.split?.rebuild?.branches ?? [];
      const conflicted = entries.findIndex((entry) => entry.conflict);
      if (conflicted < 0) return this.keep(`the tree after the rebuild differs from the final review without any merge session (${topHead.slice(0, 12)} ≠ ${finalHead.slice(0, 12)})`);
      const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', topHead, finalHead]).split('\n');
      const shown = [...diff.slice(0, TREE_DIFF_LINES), ...(diff.length > TREE_DIFF_LINES ? [`… (${diff.length - TREE_DIFF_LINES} more lines: git diff ${topHead.slice(0, 12)} ${finalHead.slice(0, 12)})`] : [])].join('\n');
      split.attempts = (split.attempts ?? 0) + 1;
      // the branches from the first conflict up are rebuilt again: their sessions are told what came out different
      for (const entry of entries.slice(conflicted)) removeClones(entry);
      split.rebuild = { branches: entries.slice(0, conflicted) };
      if (split.attempts >= limit) {
        split.attempts = 0;
        flow.save();
        throw new Halt('paused', {
          reason: 'human',
          gate: 'merge',
          message: `final review fixes: after ${limit} rebuilds the stack ends with different code than the final review (merge sessions changed the fixes); resuming tries again:\n${shown}`,
        });
      }
      const conflictedGroups = entries.slice(conflicted).filter((candidate) => candidate.conflict).map((entry) => entry.group);
      state.notes = state.notes.filter((note) => !(note.stage === 'final-review' && note.note.startsWith(TREE_DIFF_NOTE)));
      for (const group of conflictedGroups) flow.note('final-review', `${TREE_DIFF_NOTE}\n${shown}`, group);
      flow.log(`! final review fixes: the tree after the rebuild differs from the final review; merge sessions again (${split.attempts}/${limit})`);
      flow.save();
    }
  }

  /** The fixes stay where they are, on the top PR (`why`: logged as a warning); groups that withdrew theirs keep the note. */
  private keep(why?: string): void {
    const split = this.split;
    if (why) this.flow.log(`! the final review fixes stay in the last PR: ${why}`);
    for (const entry of split.rebuild?.branches ?? []) removeClones(entry);
    this.cleanUp();
    delete split.rebuild;
    delete split.moved;
    delete split.attempts;
    split.done = true;
    this.flow.save();
  }

  /** The group branches, their state and the final review's branch moved onto the rebuilt stack; frozen tests frozen again there. */
  private apply(stack: ChainSource[], results: RebuiltBranch[], assignment: FixAssignment[], finalHead: string, top: string): void {
    const { flow } = this;
    const { state } = flow;
    const repo = state.origin.repoRoot;
    for (const [index, result] of results.entries()) {
      if (!result.moved) continue;
      const source = stack[index]!;
      const groupState = state.groups[source.group.id];
      if (!groupState) continue;
      moveBranch(repo, groupState.branch, result.head, groupState.head);
      groupState.head = result.head;
      const tests = groupState.write_tests;
      if (tests) {
        const blobs = testBlobs(flow, source.group.repo, result.head, Object.keys(tests.frozen));
        const changed = Object.keys(tests.frozen).filter((file) => blobs[file] !== tests.frozen[file]);
        if (changed.length) {
          tests.frozen = refreeze(tests.frozen, blobs, changed);
          tests.commit = result.head;
        }
      }
    }
    const finalState = state.final_review!;
    const topHead = results.at(-1)!.head;
    moveBranch(repo, finalState.branch, topHead, finalHead);
    finalState.head = topHead;
    const moved: Record<string, string[]> = {};
    for (const fix of assignment) {
      for (const part of fix.parts) if (part.group !== top) (moved[part.group] ??= []).push(describePlace(part));
    }
    const split = this.split;
    split.moved = moved;
    for (const entry of split.rebuild?.branches ?? []) removeClones(entry);
    this.cleanUp();
    delete split.rebuild;
    delete split.attempts;
    split.done = true;
    flow.save();
    flow.log(`✓ final review fixes split into groups: ${Object.entries(moved).map(([group, places]) => `${group} (${places.length})`).join(', ')}`);
  }

  private cleanUp(): void {
    const repo = this.flow.state.origin.repoRoot;
    removeRestackRefs(repo, this.flow.state.slug, 'final-fix');
    for (const ref of git(repo, ['for-each-ref', '--format=%(refname)', `refs/agentic/${this.flow.state.slug}/final-fix/`]).split('\n').filter(Boolean)) {
      git(repo, ['update-ref', '-d', ref]);
    }
  }
}

/** Each group's own commits (from its predecessor's head, the first one's from the base) → the group. */
function groupCommits(repo: string, base: string, stack: ChainSource[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [index, source] of stack.entries()) {
    const from = index ? stack[index - 1]!.head : base;
    for (const commit of git(repo, ['rev-list', `${from}..${source.head}`]).split('\n').filter(Boolean)) owners.set(commit, source.group.id);
  }
  return owners;
}

/**
 * Whose lines each fix commit changes, oldest first. A hunk that changes lines goes to the group whose commits wrote
 * them (`git blame` at the commit before the fix); a pure addition to the group of the lines around it. A line an
 * earlier fix wrote belongs where that fix's hunk went. Lines of several groups, from before the feature (changed or
 * next to an addition), and whole files (new, binary, renamed, mode changed) go to `top`.
 */
export function assignFixes(repo: string, fixes: string[], owners: Map<string, string>, top: string): FixAssignment[] {
  const assigned: FixAssignment[] = [];
  const groupOfFixLine = (commit: string, file: string, line: number): string | undefined => {
    const fix = assigned.find((candidate) => candidate.commit === commit);
    const part = fix?.parts.find((candidate) => candidate.path === file && ('whole' in candidate || (line >= candidate.hunk.newStart && line < candidate.hunk.newStart + candidate.hunk.newCount)));
    return part?.group;
  };
  for (const commit of fixes) {
    const parts: FixPart[] = [];
    const renamed = new Set(
      nulFields(git(repo, ['diff', '--name-status', '-z', '-M', `${commit}^`, commit])).flatMap((fields) => (/^[RC]/.test(fields[0]!) ? fields.slice(1) : [])),
    );
    for (const [status, file] of nulFields(git(repo, ['diff', '--name-status', '-z', '--no-renames', `${commit}^`, commit])).map((fields) => [fields[0]!, fields[1]!] as const)) {
      const whole = (why: string) => parts.push({ path: file, group: top, why, whole: true });
      if (status === 'A') {
        whole('new file');
        continue;
      }
      if (renamed.has(file)) {
        whole('rename');
        continue;
      }
      if (status !== 'M' && status !== 'D') {
        whole(`type change (${status})`);
        continue;
      }
      const diff = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', `${commit}^`, commit, '--', file], false).replace(/\n$/, '');
      const { header, hunks } = parseFileDiff(diff);
      if (!hunks.length || /^(old mode|new mode|Binary files|GIT binary patch)/m.test(header) || hunks.some((hunk) => /^[-+]Subproject commit /m.test(hunk.text))) {
        whole('binary file or mode change');
        continue;
      }
      const blame = blameLines(repo, `${commit}^`, file);
      const lineGroup = (line: number): string | null => {
        const blamed = blame[line - 1];
        if (!blamed) return null;
        return owners.get(blamed.commit) ?? groupOfFixLine(blamed.commit, blamed.file, blamed.line) ?? null;
      };
      for (const hunk of hunks) {
        const lines = hunk.oldCount ? range(hunk.oldStart, hunk.oldCount) : [hunk.oldStart, hunk.oldStart + 1].filter((line) => line >= 1 && line <= blame.length);
        const { group, why } = decide(lines.map(lineGroup));
        parts.push({ path: file, group: group ?? top, ...(group ? {} : { why }), hunk, header });
      }
    }
    assigned.push({ commit, parts });
  }
  return assigned;
}

/**
 * The group of a hunk from the groups of the lines it changes, or for a pure addition of the lines around it (one at
 * the start or end of the file); `null`: a line from before the feature, which keeps the hunk on the top PR.
 */
function decide(groups: Array<string | null>): { group?: string; why?: string } {
  const known = new Set(groups.filter((group): group is string => group !== null));
  if (groups.includes(null)) return { why: 'lines from before the feature' };
  if (known.size === 1) return { group: [...known][0]! };
  if (known.size > 1) return { why: `linie kilku grup (${[...known].join(', ')})` };
  return { why: 'unknown origin of the lines' };
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => start + index);
}

function parseFileDiff(diff: string): { header: string; hunks: Hunk[] } {
  const lines = diff.split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first < 0) return { header: diff, hunks: [] };
  const hunks: Hunk[] = [];
  for (let index = first; index < lines.length; ) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]!);
    if (!match) throw new Error(`diff: unexpected line ${lines[index]}`);
    let end = index + 1;
    while (end < lines.length && !lines[end]!.startsWith('@@')) end++;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      text: lines.slice(index, end).join('\n'),
    });
    index = end;
  }
  return { header: lines.slice(0, first).join('\n'), hunks };
}

/** Per line of `file` at `revision`: the commit that wrote it, and the file and line there. */
function blameLines(repo: string, revision: string, file: string): Array<{ commit: string; file: string; line: number }> {
  const result: Array<{ commit: string; file: string; line: number }> = [];
  // `--porcelain` names a commit's file the first time (and again when it has several): remembered per commit
  const files = new Map<string, string>();
  let current: { commit: string; orig: number; final: number } | undefined;
  for (const line of git(repo, ['blame', '--porcelain', revision, '--', file], false).split('\n')) {
    const header = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(line);
    if (header) {
      current = { commit: header[1]!, orig: Number(header[2]), final: Number(header[3]) };
    } else if (current && line.startsWith('filename ')) {
      files.set(current.commit, line.slice('filename '.length));
    } else if (current && line.startsWith('\t')) {
      result[current.final - 1] = { commit: current.commit, file: files.get(current.commit) ?? file, line: current.orig };
    }
  }
  return result;
}

/**
 * Per fix commit, the commit that carries `group`'s part of it: on the fix's parent (so a rebase replays exactly that
 * part), message `<subject> (final review)`, the fix's author and dates (the same inputs give the same commit, so a
 * resumed rebuild finds its progress), the framework as committer. Kept under `refs/agentic/<slug>/final-fix/`.
 */
function fixCommits(flow: FlowRun, repo: string, assignment: FixAssignment[], group: string): string[] {
  const commits: string[] = [];
  const indexFile = path.join(flow.context.workDir, 'final-fix.index');
  const patchFile = path.join(flow.context.workDir, 'final-fix.patch');
  for (const [position, fix] of assignment.entries()) {
    const parts = fix.parts.filter((part) => part.group === group);
    if (!parts.length) continue;
    const parent = `${fix.commit}^`;
    const index = { GIT_INDEX_FILE: indexFile };
    try {
      git(repo, ['read-tree', parent], true, index);
      for (const part of parts.filter((candidate) => 'whole' in candidate)) {
        const [entry] = nulFields(git(repo, ['ls-tree', '-z', fix.commit, '--', part.path]), '\t');
        if (entry) {
          const [mode, , blob] = entry[0]!.split(' ');
          git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${part.path}`], true, index);
        } else {
          git(repo, ['update-index', '--force-remove', '--', part.path], true, index);
        }
      }
      for (const file of [...new Set(parts.filter(isHunkPart).map((part) => part.path))]) {
        fs.writeFileSync(patchFile, groupPatch(fix, file, group));
        git(repo, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', patchFile], true, index);
      }
      const tree = git(repo, ['write-tree'], true, index);
      if (tree === treeOf(repo, parent)) continue;
      const [subject, ...body] = git(repo, ['log', '-1', '--format=%B', fix.commit], false).replace(/\n+$/, '').split('\n');
      const [name, email, authorDate, committerDate] = git(repo, ['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cI', fix.commit]).split('\0');
      const message = [`${subject} (final review)`, ...body].join('\n');
      const commit = git(repo, ['commit-tree', tree, '-p', parent, '-m', message], true, {
        GIT_AUTHOR_NAME: name!,
        GIT_AUTHOR_EMAIL: email!,
        GIT_AUTHOR_DATE: authorDate!,
        GIT_COMMITTER_NAME: AGENTIC_IDENTITY.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: AGENTIC_IDENTITY.GIT_COMMITTER_EMAIL,
        GIT_COMMITTER_DATE: committerDate!,
      });
      git(repo, ['update-ref', `refs/agentic/${flow.state.slug}/final-fix/${group}/${position + 1}`, commit]);
      commits.push(commit);
    } finally {
      fs.rmSync(indexFile, { force: true });
      fs.rmSync(patchFile, { force: true });
    }
  }
  return commits;
}

type HunkPart = Extract<FixPart, { hunk: Hunk }>;

function isHunkPart(part: FixPart): part is HunkPart {
  return 'hunk' in part;
}

/**
 * `group`'s hunks of `file` from one fix commit, as a patch for the fix's parent. Each hunk's new-side start is moved
 * back by what the other groups' hunks above it added or removed: `git apply` places a hunk with no old lines (a pure
 * addition) at its new-side position, which the whole diff counts with every earlier hunk applied.
 */
function groupPatch(fix: FixAssignment, file: string, group: string): string {
  const ofFile = fix.parts.filter((part): part is HunkPart => isHunkPart(part) && part.path === file);
  const kept: string[] = [];
  let othersGrowth = 0;
  for (const { group: owner, hunk } of ofFile) {
    if (owner !== group) {
      othersGrowth += hunk.newCount - hunk.oldCount;
      continue;
    }
    kept.push(hunk.text.replace(/^(@@ -\S+ \+)\d+/, `$1${hunk.newStart - othersGrowth}`));
  }
  return `${[ofFile[0]!.header, ...kept].join('\n')}\n`;
}

/** `file:12-14` (lines after the fix; a deletion: where they were). */
function describePlace(part: FixPart): string {
  if ('whole' in part) return part.path;
  const { oldStart, oldCount, newStart, newCount } = part.hunk;
  const [start, count] = newCount ? [newStart, newCount] : [oldStart, oldCount];
  return `${part.path}:${count > 1 ? `${start}-${start + count - 1}` : start}`;
}

function moveBranch(repo: string, branch: string | undefined, head: string, previous: string | undefined): void {
  if (!branch) return;
  try {
    git(repo, ['update-ref', '-m', 'agentic: final review fixes moved into their groups', `refs/heads/${branch}`, head, ...(previous ? [previous] : [])]);
  } catch {
    // gone or moved by the human: the state holds the head either way
  }
}

function treeOf(repo: string, commit: string): string {
  return git(repo, ['rev-parse', `${commit}^{tree}`]);
}

/** `-z` output as records: name-status gives `status\0path\0` (a rename two paths), ls-tree `meta\tpath\0`. */
function nulFields(output: string, separator?: string): string[][] {
  const fields = output.split('\0').filter(Boolean);
  if (separator) return fields.map((field) => field.split(separator));
  const records: string[][] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index]!;
    const paths = /^[RC]/.test(status) ? 2 : 1;
    records.push([status, ...fields.slice(index + 1, index + 1 + paths)]);
    index += 1 + paths;
  }
  return records;
}

/** Git on the host with no output size limit (a blame of a long file, a fix's whole diff); `trim: false` keeps the text as it is. */
function git(cwd: string, args: string[], trim = true, env: Record<string, string> = {}): string {
  const result = spawnSync('git', [...SAFE_GIT, ...args], { cwd, env: { ...gitEnv(), ...env }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.stdout || String(result.error)).trim()}`);
  return trim ? result.stdout.trim() : result.stdout;
}
