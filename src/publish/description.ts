import { markdownSections, parseMarkdown, type Estimate } from '../orchestrator/artifacts.js';
import { lastRound, type FlowState, type ReviewLoopState, type SetAsideKind } from '../orchestrator/state.js';
import type { MergeDanger } from './merge-danger.js';
import type { DiffSize } from './size.js';

/** Hidden block the periodic retro finds agentic PRs by. */
export const METADATA_MARKER = 'agentic';
export const PR_LABEL = 'agentic';

export interface ReviewNote {
  scope: string;
  text: string;
}

export interface DescriptionInput {
  state: FlowState;
  /** `language.pr`: the template's own text follows it; spec and review text stay as written. */
  language: string;
  ticket: { title: string; trackerKey?: string };
  /** `spec.md` as written by the technical grill; absent when the flow had none. */
  specText?: string;
  danger: MergeDanger;
  size: DiffSize;
  framework: string;
  profile?: string;
  /** One PR of a stack: its place, its group and the list of all of them. */
  stack?: StackPosition;
}

export interface StackPosition {
  /** 0 = the lowest PR. */
  index: number;
  group: string;
  /** Groups whose review notes this PR carries: its own, those under it left without a PR of their own, and on the top one the groups outside the stack. */
  notesOf: string[];
  /** The group's goal from the plan. */
  goal?: string;
  /** The group's measured size crossed what its plan expected (`GroupSize.warning`): the estimate, if it had one. */
  missedEstimate?: { estimate?: Estimate };
  /** Bottom first; `url` once the forge opened it; `merged` once `agentic restack` saw it merged. */
  pulls: Array<{ title: string; branch: string; url?: string; merged?: boolean }>;
}

/**
 * The PR body: what the change does, what the reviewer should look at (spec risks, open nits, findings set aside or
 * accepted by a human), merge danger and size (production / tests / excluded), then the hidden metadata block.
 * In a stack: the spec's summary and risks only in the lowest PR, the list of PRs and the group's goal in each, the
 * notes of its own group and of groups under it without a PR (the final review's on the top one), the plan's estimate
 * when the group outgrew it, and the ticket closed only by the top one.
 */
export function prDescription(input: DescriptionInput): string {
  const { state, ticket, danger, size, stack } = input;
  const first = !stack || stack.index === 0;
  const last = !stack || stack.index === stack.pulls.length - 1;
  const spec = input.specText ? parseMarkdown(input.specText) : undefined;
  const text = TEMPLATE[templateLanguage(input.language)];
  // a spec from before `pr_summary` has only the gate's summary, in the conversation language
  const summary = [spec?.frontmatter.pr_summary, spec?.frontmatter.summary].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
  const risks = spec && first ? markdownSections(spec.body).get('risks')?.trim() : undefined;
  const flaggedRisks = risks && !/^none\.?$/i.test(risks) ? risks : undefined;
  // one PR (`--single`) has no group PRs for the final review's fixes to have moved into or out of
  const notes = reviewNotes(state, text, Boolean(stack)).filter((note) => !stack || stack.notesOf.includes(note.scope) || (last && note.scope === text.finalReview));
  const metadata = { slug: state.slug, ...(stack && { group: stack.group }), framework: input.framework, ...(input.profile && { profile: input.profile }) };
  return [
    ...(summary && first ? [summary, ''] : []),
    ...(ticket.trackerKey ? [ticketLine(ticket.trackerKey, text, last), ''] : []),
    ...(stack ? stackSection(stack, text) : []),
    `## ${text.lookAt}`,
    '',
    ...(flaggedRisks ? [`### ${text.risks}`, '', flaggedRisks, ''] : []),
    ...(notes.length ? [`### ${text.notes}`, '', ...notes.map((note) => `- **${note.scope}:** ${note.text}`), ''] : []),
    ...(!notes.length && !flaggedRisks ? [text.nothingFlagged, ''] : []),
    `## ${text.mergeDanger}`,
    '',
    `**${text.door}:** ${danger.door === 'one-way' ? `${text.oneWay} — ${text.oneWayWhy}` : text.twoWay}`,
    ...danger.oneWay.map((file) => `- \`${file.path}\` (\`${file.pattern}\`)`),
    '',
    `**${text.blastRadius}:** ${text.files(danger.files)} ${danger.areas.map((area) => `\`${area}\``).join(', ') || '—'}, +${danger.added} −${danger.deleted}`,
    '',
    `**${text.size}:** ${text.lines(size)}${size.over.length ? ` — ${text.overLimit(size)}` : ''}${stack?.missedEstimate ? ` — ${text.missedEstimate(stack.missedEstimate.estimate)}` : ''}`,
    '',
    '---',
    text.openedBy(state.slug),
    `<!-- ${METADATA_MARKER} ${JSON.stringify(metadata)} -->`,
  ].join('\n');
}

/**
 * Per group, then the whole feature: nits of the last round, findings set aside by the fixer, and those a human let through.
 * `stacked`: false for one PR, where the notes on final review fixes moved into or withdrawn from group PRs mean nothing.
 */
export function reviewNotes(state: FlowState, text: TemplateText = TEMPLATE.en, stacked = true): ReviewNote[] {
  const scopes: Array<[string, ReviewLoopState | undefined]> = [
    ...Object.entries(state.groups).map(([id, group]): [string, ReviewLoopState] => [id, group]),
    [text.finalReview, state.final_review],
  ];
  const split = stacked ? state.final_review?.split : undefined;
  const fixes = (group: string) => [
    ...(split?.moved?.[group]?.length ? [text.finalFixes(split.moved[group])] : []),
    ...(split?.withdrawn?.[group] ? [text.finalFixesWithdrawn(split.withdrawn[group] === group ? undefined : split.withdrawn[group])] : []),
  ];
  return scopes.flatMap(([scope, loop]) => [
    ...(loop ? loopNotes(loop, text).map((note) => ({ scope, text: note })) : []),
    ...(scope in state.groups ? fixes(scope).map((note) => ({ scope, text: note })) : []),
  ]);
}

function loopNotes(loop: ReviewLoopState, text: TemplateText): string[] {
  const nits = (lastRound(loop)?.findings ?? []).filter((finding) => finding.severity === 'nit' && finding.verdict?.status !== 'rejected');
  const setAside = (loop.set_aside ?? []).filter((entry) => entry.ruling !== 'fix');
  return [
    ...nits.map((finding) => `${where(finding)}${oneLine(finding.message)}`),
    ...setAside.map((entry) => `${where(entry.finding)}${oneLine(entry.finding.message)} — ${text.setAside[entry.kind]}: ${oneLine(entry.reason)}`),
    ...(loop.accepted ?? []).map((entry) => `${entry.id} ${text.accepted}: ${oneLine(entry.reason)}`),
  ];
}

interface TemplateText {
  ticket: string;
  partOf: string;
  stack: (position: number, count: number) => string;
  mergeOrder: string;
  thisPr: string;
  merged: string;
  goal: string;
  lookAt: string;
  risks: string;
  notes: string;
  nothingFlagged: string;
  mergeDanger: string;
  door: string;
  oneWay: string;
  oneWayWhy: string;
  twoWay: string;
  blastRadius: string;
  files: (count: number) => string;
  size: string;
  lines: (size: DiffSize) => string;
  overLimit: (size: DiffSize) => string;
  missedEstimate: (estimate: Estimate | undefined) => string;
  openedBy: (slug: string) => string;
  finalReview: string;
  /** The final review's fixes to this PR's lines that were moved into it (design: pr-stack, 3c). */
  finalFixes: (places: string[]) => string;
  /** Its fixes went to the last PR: `checks` were red with them here, or on the group `redOn` above it. */
  finalFixesWithdrawn: (redOn: string | undefined) => string;
  accepted: string;
  setAside: Record<SetAsideKind, string>;
}

/**
 * An issue of the repo (`#5`) is closed by the merge — the forge's keyword, in English in every language — of the
 * last PR only: a lower PR of a stack merged first would close it early. Another tracker's key is named.
 */
function ticketLine(trackerKey: string, text: TemplateText, closes: boolean): string {
  if (!/^#\d+$/.test(trackerKey)) return `${text.ticket}: ${trackerKey}`;
  return closes ? `Closes ${trackerKey}` : `${text.partOf} ${trackerKey}`;
}

/** Where this PR sits: every PR of the stack bottom first, this one in bold, then the group's goal. */
function stackSection(stack: StackPosition, text: TemplateText): string[] {
  const count = stack.pulls.length;
  return [
    `## ${text.stack(stack.index + 1, count)}`,
    '',
    text.mergeOrder,
    '',
    ...stack.pulls.map((pull, index) => {
      if (index === stack.index) return `${index + 1}. **${pull.title}** ← ${text.thisPr}`;
      const link = pull.url ? `[${pull.title}](${pull.url})` : `${pull.title} (\`${pull.branch}\`)`;
      return `${index + 1}. ${pull.merged ? `~~${link}~~ ✓ ${text.merged}` : link}`;
    }),
    '',
    ...(stack.goal ? [`**${text.goal}:** ${oneLine(stack.goal)}`, ''] : []),
  ];
}

/** The template's own text; a language without one gets English. */
const TEMPLATE: Record<'en' | 'pl', TemplateText> = {
  en: {
    ticket: 'Ticket',
    partOf: 'Part of',
    stack: (position, count) => `Stack: PR ${position}/${count}`,
    mergeOrder: 'Merge in this order; each PR goes into the branch of the one above it in the list.',
    thisPr: 'this PR',
    merged: 'merged',
    goal: 'Goal',
    lookAt: 'What to look at',
    risks: 'Risks (from the spec)',
    notes: 'Open review notes',
    nothingFlagged: 'Nothing flagged by the spec or the review.',
    mergeDanger: 'Merge danger',
    door: 'Door',
    oneWay: 'one-way',
    oneWayWhy: 'a revert brings back the code, not what these already did:',
    twoWay: 'two-way',
    blastRadius: 'Blast radius',
    files: (count) => `${count} ${count === 1 ? 'file' : 'files'} in`,
    size: 'Size',
    lines: (size) => `${size.prod} production / ${size.tests} tests lines, ${size.excluded} excluded (lockfiles, generated)`,
    overLimit: (size) => `over the soft limit: ${size.limits.prod} production, ${size.limits.total} with tests`,
    missedEstimate: (estimate) => (estimate ? `more than the plan's estimate of ~${estimate.prod} production / ${estimate.tests} tests` : 'the plan had no estimate'),
    openedBy: (slug) => `Opened by \`agentic publish\` from flow \`${slug}\`.`,
    finalReview: 'final review',
    finalFixes: (places) => `the final review's fixes to this PR's lines are here, in the commits marked \`(final review)\`: ${places.map((place) => `\`${place}\``).join(', ')}`,
    finalFixesWithdrawn: (redOn) => `the final review's fixes to this PR's lines are in the last PR of the stack: checks were red with them ${redOn ? `on \`${redOn}\`` : 'here'}`,
    accepted: 'accepted by a human',
    setAside: { disputed: 'disputed by the fixer', severity: 'weight disputed by the fixer', not_reproduced: 'not reproduced' },
  },
  pl: {
    ticket: 'Ticket',
    partOf: 'Część',
    stack: (position, count) => `Stack: PR ${position}/${count}`,
    mergeOrder: 'Merge’uj w tej kolejności; każdy PR idzie do gałęzi PR-a nad nim na liście.',
    thisPr: 'ten PR',
    merged: 'zmergowany',
    goal: 'Cel',
    lookAt: 'Na co patrzeć',
    risks: 'Ryzyka (ze specu)',
    notes: 'Otwarte uwagi z review',
    nothingFlagged: 'Ani spec, ani review niczego nie oznaczyły.',
    mergeDanger: 'Ryzyko merge’a',
    door: 'Drzwi',
    oneWay: 'jednokierunkowe',
    oneWayWhy: 'revert przywróci kod, ale nie cofnie tego, co te zmiany już zrobią:',
    twoWay: 'dwukierunkowe',
    blastRadius: 'Zasięg',
    files: (count) => `${count} ${polishFiles(count)} w`,
    size: 'Rozmiar',
    lines: (size) => `${size.prod} linii produkcyjnych / ${size.tests} testów, ${size.excluded} pominiętych (lockfile’i, generowane)`,
    overLimit: (size) => `ponad miękki próg: ${size.limits.prod} produkcyjnych, ${size.limits.total} razem z testami`,
    missedEstimate: (estimate) => (estimate ? `więcej niż szacunek planu ~${estimate.prod} produkcyjnych / ${estimate.tests} testów` : 'plan bez szacunku'),
    openedBy: (slug) => `Otwarty przez \`agentic publish\` z flow \`${slug}\`.`,
    finalReview: 'finalne review',
    finalFixes: (places) => `poprawki finalnego review do linii tego PR-a są tutaj, w commitach \`(final review)\`: ${places.map((place) => `\`${place}\``).join(', ')}`,
    finalFixesWithdrawn: (redOn) => `poprawki finalnego review do linii tego PR-a są w ostatnim PR-ze stacku: checks były z nimi czerwone ${redOn ? `na \`${redOn}\`` : 'tutaj'}`,
    accepted: 'przyjęte przez człowieka',
    setAside: { disputed: 'fixer się nie zgadza', severity: 'fixer kwestionuje wagę', not_reproduced: 'nie odtworzone' },
  },
};

function polishFiles(count: number): string {
  if (count === 1) return 'plik';
  return count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14) ? 'pliki' : 'plików';
}

function templateLanguage(language: string): keyof typeof TEMPLATE {
  return /^(pl|pol|polish|polski)\b/i.test(language) ? 'pl' : 'en';
}

function where(finding: { file?: string; line?: number }): string {
  return finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\` ` : '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
