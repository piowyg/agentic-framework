// The shape of a rule id, shared by the parser of standards/skills and the check of a finding's basis.

/** `ARCH-01`, `TEST-12`, and the framework's `AG-CODE-01`: one or more uppercase segments, then a number. */
export const RULE_ID = '[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\\d+';

/** Framework rules carry this prefix; standards and repo skills may not use it, so a team's `CODE-01` never collides. */
export const FRAMEWORK_RULE_PREFIX = 'AG-';
