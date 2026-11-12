import { ArtifactError, validateTicket } from '../orchestrator/artifacts.js';

const MAX_TITLE = 80;

/** First non-empty line without markdown markers; the slug comes from it. */
export function pastedTitle(text: string): string {
  // frontmatter is skipped by shape: a pasted one may not parse
  const line = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split('\n')
    .map((candidate) => candidate.replace(/^\s*(#+|[-*>]|\d+[.)])\s*/, '').trim())
    .find(Boolean);
  return (line ?? 'pomysl').slice(0, MAX_TITLE);
}

/** A ticket within the contract starts at the technical grill; any other text is an idea for the business grill. */
export type ClassifiedTicket = { kind: 'ticket'; title: string } | { kind: 'idea'; title: string; problems: string[] };

/** `untitled` names a ticket that has neither `tracker_key` nor `title`; by default its first line does. */
export function classifyTicket(text: string, untitled = pastedTitle(text)): ClassifiedTicket {
  try {
    const ticket = validateTicket(text);
    return { kind: 'ticket', title: ticket.trackerKey ?? ticket.title ?? untitled };
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    return { kind: 'idea', title: pastedTitle(text), problems: error.problems };
  }
}
