/** The flow's languages: artifacts and PRs belong to the team, the conversation to the person. */
export interface Languages {
  artifacts: string;
  conversation?: string;
  pr?: string;
}

export function conversationLanguage(language: Languages): string {
  return language.conversation ?? language.artifacts;
}

/** What reviewers read the PR description in: `language.pr`, else the artifacts' language. */
export function prLanguage(language: Languages): string {
  return language.pr ?? language.artifacts;
}

/** The language a separate `pr_summary` is written in; undefined when the gate summary already is in it. */
export function prSummaryLanguage(language: Languages): string | undefined {
  const pr = prLanguage(language);
  return pr === conversationLanguage(language) ? undefined : pr;
}
