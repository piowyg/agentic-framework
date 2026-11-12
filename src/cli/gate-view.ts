import { styleText } from 'node:util';
import type { GateName } from '../config/types.js';
import { groupTier, type Group } from '../orchestrator/artifacts.js';
import { linesText, overLimits, thresholdsText, type SizeThresholds } from '../publish/size.js';
import type { GateView } from '../orchestrator/gates.js';
import { sanitize } from './sanitize.js';
import { plural } from '../plural.js';

/** Bold, dim and colors for the terminal; plain text when it isn't one (or `NO_COLOR`). */
export interface Styles {
  bold(text: string): string;
  dim(text: string): string;
  warn(text: string): string;
}

export const PLAIN: Styles = { bold: (text) => text, dim: (text) => text, warn: (text) => text };

export function terminalStyles(stream: NodeJS.WriteStream = process.stdout): Styles {
  return {
    bold: (text) => styleText('bold', text, { stream }),
    dim: (text) => styleText('dim', text, { stream }),
    warn: (text) => styleText('yellow', text, { stream }),
  };
}

const MAX_WIDTH = 110;

/**
 * The gate's header and body. Text from agents is sanitized; the human-language `summary` fields
 * lead in bold, the agents' English details follow dimmed, wrapped under their item.
 */
export function renderGate(gate: GateName, group: string | undefined, view: GateView, styles: Styles, columns = 100): string {
  const width = Math.max(40, Math.min(columns, MAX_WIDTH));
  const header = `━━ Gate: ${gate}${group ? ` (${group})` : ''} ━━`;
  return view.kind === 'breakdown' ? renderPlan(header, view, styles, width) : renderDocument(header, view, styles, width);
}

function renderPlan(header: string, view: Extract<GateView, { kind: 'breakdown' }>, styles: Styles, width: number): string {
  const taskCount = view.groups.reduce((count, group) => count + group.tasks.length, 0);
  const counts = [plural(view.groups.length, 'group', 'groups'), plural(taskCount, 'task', 'tasks'), `covers ${view.acceptance.join(', ')}`];
  const lines = [`${styles.bold(header)}  ${counts.join(' · ')}`, ''];
  for (const warning of view.warnings) lines.push(styles.warn(`⚠ ${clean(warning)}`), '');
  for (const group of view.groups) lines.push(...renderGroup(group, styles, width, view.limits), '');
  lines.push(styles.dim(`Full plan: ${view.file}`));
  return lines.join('\n');
}

/** The criteria share at most this part of a task line beside its title; longer, they get lines of their own. */
const ACCEPTANCE_SHARE = 3;

function renderGroup(group: Group, styles: Styles, width: number, limits?: SizeThresholds): string[] {
  const { estimate } = group;
  const meta = [
    group.repo === '.' ? undefined : `repo ${group.repo}`,
    groupTier(group),
    group.depends_on.length ? `after ${group.depends_on.join(', ')}` : undefined,
    estimate ? `~${linesText(estimate.prod, estimate.tests)}` : undefined,
  ];
  const [headline, details] = headlineOf(group.summary, group.title ?? group.rationale);
  const metaText = meta.filter(Boolean).join(' · ');
  const bullet = `▸ ${group.id}  `;
  const [first, ...rest] = wrap(headline, width - bullet.length - metaText.length - 2, '');
  const lines = [`${styles.bold(bullet + first!)}  ${styles.dim(metaText)}`, ...rest.map((line) => styles.bold(`    ${line}`))];
  // the title's leftover and the rationale are separate paragraphs; without a title the rationale is the headline
  for (const paragraph of [details, group.title === undefined ? '' : clean(group.rationale)].filter(Boolean)) {
    lines.push(...wrap(paragraph, width, '  ').map(styles.dim));
  }
  if (estimate && limits && overLimits(estimate.prod, estimate.tests, limits).length) {
    const over = `⚠ over the publish.size threshold (${thresholdsText(limits)})`;
    const reason = group.oversize_reason?.trim();
    lines.push(...wrap(reason ? `${over}: ${clean(reason)}` : `${over} with no reason given`, width, '  ').map(styles.warn));
  }
  group.tasks.forEach((task, index) => {
    const last = index === group.tasks.length - 1;
    const acceptance = task.acceptance.length ? `  ${task.acceptance.join(' ')}` : '';
    const branch = `  ${last ? '└─' : '├─'} ${task.id.padEnd(4)} ${(task.tier ?? '').padEnd(10)} `;
    const continuation = `  ${last ? ' ' : '│'}${' '.repeat(branch.length - 3)}`;
    const [taskHeadline, taskDetails] = headlineOf(task.summary, task.title);
    // a long criteria list goes under the title rather than squeeze it into a narrow column (acceptance smoke, finding 4)
    const inline = acceptance.length <= (width - branch.length) / ACCEPTANCE_SHARE;
    const [first, ...rest] = wrap(taskHeadline, width - branch.length - (inline ? acceptance.length : 0), '');
    lines.push(`${branch}${styles.bold(first!)}${inline ? styles.dim(acceptance) : ''}`, ...rest.map((line) => continuation + styles.bold(line)));
    if (!inline) lines.push(...wrap(task.acceptance.join(' '), width, continuation).map((line) => continuation + styles.dim(line.slice(continuation.length))));
    if (taskDetails) lines.push(...wrap(taskDetails, width, continuation).map((line) => continuation + styles.dim(line.slice(continuation.length))));
  });
  return lines;
}

/** The human-language summary leads; without one, the first sentence of the agents' text, the rest as details. */
function headlineOf(summary: string | undefined, text: string): [string, string] {
  const details = clean(text);
  if (summary?.trim()) return [clean(summary), details];
  const sentence = /^(.+?[.!?])\s+(\S.*)$/.exec(details);
  return sentence ? [sentence[1]!, sentence[2]!] : [details, ''];
}

function renderDocument(header: string, view: Extract<GateView, { kind: 'document' }>, styles: Styles, width: number): string {
  const lines = [`${styles.bold(header)}${view.title ? `  ${clean(view.title)}` : ''}`, ''];
  lines.push(...(view.summary ? wrap(clean(view.summary), width, '').map(styles.bold) : [styles.dim('(no summary; see the file)')]));
  lines.push('', ...view.facts.map((fact) => styles.dim(clean(fact))), styles.dim(`File: ${view.file}`));
  return lines.join('\n');
}

/** One line, no control characters: agent text never moves the cursor or breaks the layout. */
function clean(text: string): string {
  return sanitize(text.replace(/\s+/g, ' ')).trim();
}

/** Word wrap to `width`, every line prefixed with `indent`; a word longer than a line stays whole. */
export function wrap(text: string, width: number, indent: string): string[] {
  const room = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line || !lines.length) lines.push(indent + line);
  return lines;
}
