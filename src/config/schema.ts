// Single source of truth for config validation, config types (types.ts) and docs/reference/config.md.
// All fields are optional: a layer sets only what it overrides; defaults live in defaults.ts.
import Type, { type Static, type TOptional, type TSchema } from 'typebox';
import { RULE_ID } from '../review/rule-id.js';

export const HARNESSES = ['claude', 'codex'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const TIERS = ['mechanical', 'standard', 'domain', 'design'] as const;
export const GATES = ['ticket', 'spec', 'breakdown', 'group', 'merge', 'final'] as const;
export const AUTONOMY = ['strict', 'standard', 'autopilot', 'custom'] as const;
export const STAGE_CONFIG_KEYS = [
  'grill-business',
  'grill-technical',
  'breakdown',
  'write-tests',
  'implement',
  'fix',
  'merge',
  'review-spec',
  'review-standards',
  'review-security',
  'review-final',
] as const;
export function isStageConfigKey(name: string): name is (typeof STAGE_CONFIG_KEYS)[number] {
  return (STAGE_CONFIG_KEYS as readonly string[]).includes(name);
}
/** Review perspectives, run in this order; each is `executor | null` in `review`. */
export const REVIEW_AXES = ['spec', 'standards', 'security'] as const;
export const STOP_TRIGGERS = ['max_rounds', 'repeated_finding', 'disputed', 'no_progress', 'budget'] as const;
export const STOP_ACTIONS = ['escalate', 'human', 'fail'] as const;
export const NOTIFY_EVENTS = ['human_needed', 'group_blocked', 'flow_paused', 'rate_limited', 'group_done', 'flow_done', 'flow_failed'] as const;
export const SANDBOX_MODES = ['container', 'none'] as const;
export const CONTAINER_ENGINES = ['podman', 'docker'] as const;
export const CACHES = ['gradle', 'maven', 'npm', 'playwright'] as const;

/** `90s`, `5m`. */
export const DURATION_PATTERN = '^[1-9][0-9]*(s|m)$';

/** Skill names become paths later: no separators or dots. */
const SKILL_PATTERN = '^(team:|repo:)?[a-z0-9][a-z0-9-]*$';

/** Language tag or name the agent understands, e.g. `en`, `pl`. */
const languageField = (description: string) => Type.String({ pattern: '^[A-Za-z][A-Za-z-]{1,30}$', description });

const closed = { additionalProperties: false } as const;

/** An object whose keys are all optional (config layers override single fields). */
function optionalObject<Properties extends Record<string, TSchema>>(properties: Properties, options: { description?: string } = {}) {
  const optional = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, Type.Optional(schema)]));
  return Type.Object(optional as { [Key in keyof Properties]: TOptional<Properties[Key]> }, { ...closed, ...options });
}

/** One optional entry per key, all with the same schema. */
function objectOf<Key extends string, Value extends TSchema>(keys: readonly Key[], value: (key: Key) => Value, options: { description?: string } = {}) {
  return optionalObject(Object.fromEntries(keys.map((key) => [key, value(key)])) as { [K in Key]: Value }, options);
}

const executorFields = {
  harness: Type.Enum([...HARNESSES], { description: 'The agent CLI.' }),
  model: Type.String({ description: 'Model alias from the catalog (e.g. `opus`, `luna`).' }),
  effort: Type.Enum([...EFFORTS], { description: 'Effort (reasoning) level.' }),
};

/** Session executor; also used by tasks.yaml overrides (artifacts.ts). */
export const executorSchema = optionalObject(executorFields, {
  description: 'Session executor: which harness, model (alias from the model catalog) and effort.',
});

const AXIS_DESCRIPTIONS: Record<(typeof REVIEW_AXES)[number], string> = {
  spec: 'Reviewer for the spec axis (does it deliver the ticket/spec/ACs). `null` = axis off.',
  standards: 'Reviewer for the standards axis (archetype/conventions/quality). `null` = axis off.',
  security: 'Reviewer for the security axis (trust boundaries, where untrusted input ends up). `null` = axis off.',
};

const skillName = Type.String({ pattern: SKILL_PATTERN });

const stage = optionalObject(
  {
    ...executorFields,
    skills: Type.Array(skillName, {
      description: 'Practice skills for the stage. Prefixes: `team:` (workspace), `repo:` (service), none (global/framework).',
    }),
    stage_skill: Type.String({ pattern: SKILL_PATTERN, description: 'Replaces the stage skill (must keep the output contract).' }),
  },
  { description: 'Stage settings: executor + skills.' },
);

const writeTestsStage = Type.Object(
  {
    ...stage.properties,
    enabled: Type.Optional(Type.Boolean({ description: '`false` turns the stage off: group tasks without tests written first.' })),
  },
  { ...closed, description: 'The `write-tests` stage: executor, skills and switch.' },
);

const budget = optionalObject(
  {
    minutes: Type.Number({ exclusiveMinimum: 0, description: 'Flow time limit (minutes).' }),
    tokens: Type.Integer({ exclusiveMinimum: 0, description: 'Token limit (input + output).' }),
    usd: Type.Number({ exclusiveMinimum: 0, description: 'Cost limit in USD (needs `pricing`).' }),
  },
  { description: 'Usage limits for the whole flow, checked before each session from `usage.jsonl`: minutes = total time of sessions without a human (not the grill, not waiting at gates). Going over = a question: continue with the limit +50% or pause.' },
);

const tracker = Type.Object(
  {
    type: Type.Enum(['jira', 'github', 'none'], { description: 'Tracker type.' }),
    url: Type.Optional(Type.String({ description: 'Instance URL (Jira).' })),
    project: Type.Optional(Type.String({ description: 'Project key (Jira) or `owner/repo` (GitHub).' })),
    auth: Type.Optional(
      Type.Object(
        { env: Type.String({ description: 'Name of the environment variable holding the token.' }) },
        { ...closed, description: 'Where to get the token from; never inline in the file.' },
      ),
    ),
    auto_push: Type.Optional(Type.Enum(['ask', 'never', 'always'], { description: 'Whether to push the ticket after the `ticket` gate.' })),
  },
  { ...closed, description: 'Issue tracker (import/export only).' },
);

export const FORGES = ['github', 'gitlab', 'none'] as const;
export const TOKEN_CLIS = ['gh', 'glab'] as const;

const forge = Type.Object(
  {
    type: Type.Enum([...FORGES], { description: 'Code platform: `none` = `publish` only pushes the branch and prints a link to create the PR.' }),
    url: Type.Optional(Type.String({ pattern: '^https://[^\\s/]+(/[^\\s]*)?$', description: 'Instance URL (GitHub Enterprise, self-hosted GitLab); unset = the host of `origin`.' })),
    auth: Type.Optional(
      Type.Union(
        [
          Type.Object({ env: Type.String({ description: 'Name of the environment variable holding the token.' }) }, closed),
          Type.Object({ from: Type.Enum([...TOKEN_CLIS], { description: 'Token from a logged-in CLI: `gh auth token` or `glab config get token`.' }) }, closed),
        ],
        { description: 'Where to get the token from; never inline in the file.' },
      ),
    ),
  },
  { ...closed, description: 'Forge for `agentic publish`: the orchestrator calls the REST API; the agent never gets the token.' },
);

const tiers = objectOf(TIERS, () => executorSchema, { description: 'Maps a task difficulty tier to an executor.' });

const price = Type.Object(
  {
    in: Type.Number({ minimum: 0, description: 'Input (USD / 1M tokens).' }),
    out: Type.Number({ minimum: 0, description: 'Output (USD / 1M tokens).' }),
    cache_read: Type.Optional(Type.Number({ minimum: 0, description: 'Prompt cache read; unset = the `in` price.' })),
  },
  closed,
);

const profile = optionalObject(
  {
    match: optionalObject(
      {
        remote: Type.String({ description: 'Glob on the `origin` URL, e.g. `*gitlab.example.com*`.' }),
        path: Type.String({ description: 'Glob on the repo path, e.g. `~/projects/**`.' }),
      },
      { description: 'Match conditions (globs). One match is enough.' },
    ),
    billing: Type.Enum(['api', 'subscription'], { description: 'Billing: API (tokens/USD) or subscription.' }),
    pricing: Type.Record(Type.String(), price, { description: 'Prices per model alias (USD per 1M tokens).' }),
    budget,
    tracker,
    forge,
    on_rate_limit: Type.Enum(['pause_and_notify', 'wait', 'fail'], {
      description: 'What to do on a rate limit: pause, wait for the limit reset (at most 5 h, then pause) or fail.',
    }),
    tiers,
  },
  { description: 'A profile (e.g. `work`, `private`) picked automatically by git remote or path.' },
);

/** `{name: threshold}` form of a stop trigger. */
function thresholdTrigger<Name extends string, Threshold extends TSchema>(name: Name, threshold: Threshold) {
  return Type.Object({ [name]: threshold } as { [K in Name]: Threshold }, closed);
}

const stopTrigger = Type.Union([
  Type.Enum([...STOP_TRIGGERS]),
  thresholdTrigger('diff_growth', Type.Number({ exclusiveMinimum: 1 })),
  thresholdTrigger('checks_failing', Type.Integer({ minimum: 1 })),
  thresholdTrigger('rejection_rate', Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
]);

const axisReviewer = (axis: (typeof REVIEW_AXES)[number]) => Type.Union([executorSchema, Type.Null()], { description: AXIS_DESCRIPTIONS[axis] });
const axisReviewers = Object.fromEntries(REVIEW_AXES.map((axis) => [axis, axisReviewer(axis)])) as {
  [Axis in (typeof REVIEW_AXES)[number]]: ReturnType<typeof axisReviewer>;
};

const review = optionalObject(
  {
    ...axisReviewers,
    final: optionalObject(executorFields, { description: 'Final review of the whole feature.' }),
    checks: Type.Union([Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), Type.Literal('none')], {
      description:
        'The deterministic gate: build/test/lint commands (each through `sh -c` in the group clone). Required to start a flow; `none` = knowingly without verification (groups marked "unverified"). With `sandbox.mode: none` they need consent per repo (`~/.agentic/trusted-checks.yaml`).',
    }),
    compile: Type.String({
      minLength: 1,
      description: 'Compiles code and tests without running them (e.g. `./gradlew testClasses`): the "red" gate after `write-tests` and the gate after each task. With `sandbox.mode: none` covered by the same consent as `checks`.',
    }),
    test_reports: Type.String({
      minLength: 1,
      description: 'Glob of JUnit XML reports relative to the clone (e.g. `**/build/test-results/test/*.xml`); without them the test gates fall back to the exit codes of `checks`. The "red" gate needs a report from every test suite while others are red: the command must not stop at the first red task (Gradle: `--continue`, and when one task depends on another, separate commands, e.g. `./gradlew test` and `./gradlew integration -x test`).',
    }),
    checks_timeout: Type.String({ pattern: DURATION_PATTERN, description: 'Time limit for one `checks` command, e.g. `5m`, `90s`; capped at `checks_timeout_max`.' }),
    checks_timeout_max: Type.String({ pattern: DURATION_PATTERN, description: 'Hard ceiling for `checks_timeout`. Global config only.' }),
    max_rounds: Type.Integer({ minimum: 1, description: 'Maximum number of review → fix rounds.' }),
    stop_on: Type.Array(stopTrigger, {
      description:
        'Loop stop triggers: `max_rounds`, `repeated_finding`, `disputed`, `no_progress`, `{diff_growth: x}`, `{checks_failing: n}`, `{rejection_rate: x}`; `budget` changes nothing (the flow budget is always checked).',
    }),
    on_stop: Type.Array(Type.Enum([...STOP_ACTIONS]), { minItems: 1, description: 'Action chain after a stop: `escalate` (a fixer round one rung up in `escalation`; past the top, the chain goes on), `human`, `fail`.' }),
    escalation: Type.Array(Type.String(), { description: 'Model ladder for `escalate` (e.g. `[luna, sol, astra]`), starting above the fixer model. Empty = off.' }),
  },
  { description: 'The review loop.' },
);

const sandbox = optionalObject(
  {
    mode: Type.Enum([...SANDBOX_MODES], { description: '`container` = sessions in a container; `none` = local without isolation (with a warning).' }),
    engine: Type.Enum([...CONTAINER_ENGINES], { description: 'Container engine for `mode: container`.' }),
    network: optionalObject({ allow: Type.Array(Type.String(), { description: 'Host allowlist.' }) }),
    image: optionalObject({
      base: Type.String({ description: 'Base image.' }),
      stack: Type.String({
        description:
          'Stack layer: `auto` (build files in the repo or a top-level directory: Gradle/Maven → `jvm`, otherwise the base image), `jvm` (JDK 17/21/25), `none`/`node` (the base image has Node), or the name of your own image.',
      }),
    }),
    containers: Type.Boolean({
      description:
        'Containers inside a session (Testcontainers, `docker compose`): rootless Podman in the session container, with `DOCKER_HOST` on its socket; Docker Hub images through the allowlist, each session has its own storage (removed with it). Weaker isolation (docs/en/security.md): only for repos that need it.',
    }),
    caches: Type.Array(Type.Enum([...CACHES]), { description: 'Shared dependency caches (`agentic-cache-*` volumes, common to all sessions).' }),
    host: optionalObject(
      {
        read: Type.Array(Type.String(), {
          description:
            'Parts of the home directory a host session may read, with the shell and file tools (toolchains, dependency caches, working material next to the repo); the rest of home is closed, credentials always. Global config only.',
        }),
        deny: Type.Array(Type.String(), { description: 'Extra paths closed to host sessions (besides the built-in credentials list).' }),
      },
      { description: 'Reads outside the session directories with `mode: none`.' },
    ),
  },
  { description: 'The implementation sandbox.' },
);

export const configSchema = Type.Object(
  {
    profiles: Type.Optional(Type.Record(Type.String(), profile, { description: 'Profiles (usually in the global config `~/.agentic/config.yaml`).' })),
    default_profile: Type.Optional(Type.String({ description: 'The profile when no `match` fits.' })),
    workspaces: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Trusted workspace directories (global config only). A workspace inside a repo that is not on the list cannot set `sandbox`.',
      }),
    ),
    tiers: Type.Optional(tiers),
    stages: Type.Optional(
      objectOf<(typeof STAGE_CONFIG_KEYS)[number], typeof stage | typeof writeTestsStage>(STAGE_CONFIG_KEYS, (key) => (key === 'write-tests' ? writeTestsStage : stage), {
        description:
          'Stage settings: the stage skill and practice skills. The implement executor comes from `tiers`, review from `review.<axis>`, fix from the group; those stages only set skills (fix also an executor override).',
      }),
    ),
    review: Type.Optional(review),
    skills: Type.Optional(
      optionalObject(
        {
          disabled: Type.Array(skillName, {
            uniqueItems: true,
            description: 'Practice skills turned off in all stages (e.g. `agentic-clean-code`); a stage skill cannot be turned off, `stage_skill` replaces it.',
          }),
        },
        { description: 'Framework and team skills across the whole flow. The array replaces the one from a lower layer (repo overrides workspace).' },
      ),
    ),
    rules: Type.Optional(
      optionalObject(
        {
          disabled: Type.Array(Type.String({ pattern: `^${RULE_ID}$` }), {
            uniqueItems: true,
            description: 'Rules turned off by ID (e.g. `AG-CODE-03`): the skill stays, agents do not apply the rule, review does not report it.',
          }),
        },
        { description: 'Single rules of standards and skills. The array replaces the one from a lower layer.' },
      ),
    ),
    language: Type.Optional(
      optionalObject(
        {
          artifacts: languageField('Language of flow artifacts (ticket, spec, reports); set by the team/repo.'),
          conversation: languageField('Language of the conversation in interactive stages (personal); unset = same as `artifacts`.'),
          pr: languageField(
            'Language of the PR/MR description from `agentic publish` (team); unset = same as `artifacts`. When it differs from the conversation language, the technical grill also writes `pr_summary` in it; risks and review findings stay in the artifacts language.',
          ),
        },
        { description: 'Flow languages. Skills and contracts are always in English.' },
      ),
    ),
    autonomy: Type.Optional(Type.Enum([...AUTONOMY], { description: 'Gate preset. `custom` needs `gates`.' })),
    gates: Type.Optional(Type.Array(Type.Enum([...GATES]), { uniqueItems: true, description: 'Active gates with `autonomy: custom`.' })),
    budget: Type.Optional(budget),
    session_timeout: Type.Optional(
      Type.String({ pattern: DURATION_PATTERN, description: 'Time limit for one session without a human, e.g. `45m`; past it the session is killed and the group paused. Interactive sessions have no limit.' }),
    ),
    sandbox: Type.Optional(sandbox),
    git: Type.Optional(
      optionalObject({
        branch_prefix: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$', description: 'Prefix of flow branches.' }),
        branch_pattern: Type.String({
          pattern: '^[A-Za-z0-9{][A-Za-z0-9._/{}-]*$',
          description:
            'Name of the branch `publish` pushes: `{type}` (from commits: `feat`, `fix`…), `{ticket}` (tracker key without `#`), `{title}` (ticket title as a slug), `{slug}` (the flow slug), `{group}` (group title as a slug; one PR for everything: the ticket title). In a stack a pattern without `{group}` gets a `-1`, `-2`, … suffix; a flow with one group has no suffix.',
        }),
        commit_convention: Type.Enum(['conventional', 'free'], { description: 'The agent commit convention.' }),
      }),
    ),
    notify: Type.Optional(
      optionalObject(
        {
          on: Type.Array(Type.Enum([...NOTIFY_EVENTS]), {
            description: 'Events to notify about; `group_blocked` and `flow_paused` skip pauses a human chose (stop at a gate), and a flow pause after an already reported group notifies once.',
          }),
          command: Type.String({
            description:
              'A command (`sh -c`) instead of the terminal bell, e.g. `afplay /System/Library/Sounds/Glass.aiff`; gets `AGENTIC_EVENT`, `AGENTIC_SLUG`, `AGENTIC_GROUP`, `AGENTIC_MESSAGE`. Global config only.',
          }),
        },
        { description: 'Notifications.' },
      ),
    ),
    publish: Type.Optional(
      optionalObject(
        {
          one_way_paths: Type.Array(Type.String({ minLength: 1 }), {
            description:
              'Globs of paths whose change is one-way (migrations, contracts): `publish` says so in the PR "Merge danger" section, and the `final` gate then asks in every preset. The array replaces the one from a lower layer.',
          }),
          stack: Type.Boolean({
            description:
              'A stack of PRs: the groups of one repo form a chain (breakdown must cut the plan that way), each becomes a PR on the branch of the previous one. `false` = groups of one repo may run in parallel, `publish` makes one PR for everything.',
          }),
          size: Type.Optional(
            optionalObject(
              {
                max_prod_lines: Type.Integer({ minimum: 1, description: 'Soft threshold for production lines (added + deleted, docs count); going over = a warning in the `publish` plan, in the PR description and on a finished group whose estimate was under the threshold (or over it, and the diff exceeded 2× the estimate).' }),
                max_total_lines: Type.Integer({ minimum: 1, description: 'Soft threshold for production and test lines together; going over = a warning.' }),
                tests: Type.Array(Type.String({ minLength: 1 }), { description: 'Globs of test files, counted apart from production ones. The array replaces the one from a lower layer.' }),
                exclude: Type.Array(Type.String({ minLength: 1 }), {
                  description:
                    'Globs of files left out of the size (lockfiles, generated files); files marked `linguist-generated` in `.gitattributes` are always left out. The array replaces the one from a lower layer.',
                }),
              },
              { description: 'Change size: production / test / excluded lines, with soft thresholds.' },
            ),
          ),
        },
        { description: '`agentic publish`.' },
      ),
    ),
    parallel_groups: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 16, description: 'How many implement groups (without mutual dependencies) may run at once.' }),
    ),
    sync: Type.Optional(
      optionalObject({ policy: Type.Enum(['auto', 'warn', 'block'], { description: 'Workspace sync at the start of a flow.' }) }),
    ),
    requires_framework: Type.Optional(Type.String({ description: 'Required framework version (semver range), e.g. `>=1.4`.' })),
  },
  { ...closed, $id: 'https://agentic.local/config.schema.json', title: 'Agentic config' },
);

/** One config file (layer) as written by the user. */
export type ConfigLayer = Static<typeof configSchema>;
export type StageSchema = Static<typeof stage> & Pick<Static<typeof writeTestsStage>, 'enabled'>;
export type ProfileSchema = Static<typeof profile>;
export type BudgetSchema = Static<typeof budget>;
