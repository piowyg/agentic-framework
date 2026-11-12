// Config types are derived from schema.ts, so validation and types cannot drift apart.
import type {
  AUTONOMY,
  BudgetSchema,
  ConfigLayer,
  EFFORTS,
  GATES,
  HARNESSES,
  NOTIFY_EVENTS,
  ProfileSchema,
  REVIEW_AXES,
  CACHES,
  CONTAINER_ENGINES,
  SANDBOX_MODES,
  STAGE_CONFIG_KEYS,
  StageSchema,
  STOP_ACTIONS,
  TIERS,
} from './schema.js';

export type { ConfigLayer } from './schema.js';
import type { Languages } from './language.js';

export type HarnessName = (typeof HARNESSES)[number];
export type Effort = (typeof EFFORTS)[number];
export type Tier = (typeof TIERS)[number];
export type GateName = (typeof GATES)[number];
export type Autonomy = (typeof AUTONOMY)[number];
export type StageConfigKey = (typeof STAGE_CONFIG_KEYS)[number];
export type StopAction = (typeof STOP_ACTIONS)[number];
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export type ReviewAxis = (typeof REVIEW_AXES)[number];
export type SandboxMode = (typeof SANDBOX_MODES)[number];
export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];
export type CacheName = (typeof CACHES)[number];
export type StopTrigger = NonNullable<ReviewLayer['stop_on']>[number];

/** Executor after merging: every field known (harness from the catalog, effort from defaults). */
export type Executor = Required<NonNullable<NonNullable<ConfigLayer['tiers']>[Tier]>>;
export type StageConfig = StageSchema;
export type Budget = BudgetSchema;
export type Profile = ProfileSchema;
export type TrackerConfig = NonNullable<Profile['tracker']>;
export type ForgeConfig = NonNullable<Profile['forge']>;

type ReviewLayer = NonNullable<ConfigLayer['review']>;

/** `null` switches an axis off; at least one axis stays enabled. */
export type ReviewAxes = Record<ReviewAxis, Executor | null>;

/** Without a default: the tests' gates fall back to the exit codes of `checks`. */
type OptionalReviewKeys = 'compile' | 'test_reports';

export type ReviewConfig = ReviewAxes &
  Required<Omit<ReviewLayer, ReviewAxis | 'final' | OptionalReviewKeys>> &
  Pick<ReviewLayer, OptionalReviewKeys> & { final: Executor };

/** All keys required, recursively into nested objects (not arrays); `null` is kept. */
type Filled<Section> = {
  [Key in keyof Section]-?: NonNullable<Section[Key]> extends readonly unknown[]
    ? NonNullable<Section[Key]>
    : NonNullable<Section[Key]> extends object
      ? Filled<NonNullable<Section[Key]>>
      : Exclude<Section[Key], undefined>;
};

/** Sections that stay optional after merging (no default). */
type OptionalKeys = 'default_profile' | 'workspaces' | 'gates' | 'requires_framework' | 'skills' | 'rules';

/** Merged config; every section is filled from defaults. */
export type AgenticConfig = Pick<ConfigLayer, OptionalKeys> &
  Filled<Pick<ConfigLayer, 'autonomy' | 'parallel_groups' | 'sandbox' | 'git' | 'sync' | 'session_timeout' | 'publish'>> & {
    language: Languages;
    profiles: Record<string, Profile>;
    tiers: Record<Tier, Executor>;
    stages: Record<StageConfigKey, StageConfig>;
    review: ReviewConfig;
    budget: Budget;
    notify: Filled<Omit<NonNullable<ConfigLayer['notify']>, 'command'>> & { command?: string };
  };
