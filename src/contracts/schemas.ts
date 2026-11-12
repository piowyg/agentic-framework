// Output contracts of agent sessions: the single source for the parsers and for the contract text
// the orchestrator appends to every prompt. Descriptions are in English — they are read by the agent.
import Type, { type Static, type TSchema } from 'typebox';

/** Bumped on every incompatible change; an artifact with another version is rejected. */
export const CONTRACT_VERSION = 1;

const contract = Type.Literal(CONTRACT_VERSION, { description: `Contract version, always ${CONTRACT_VERSION}.` });

const acceptanceId = Type.String({ pattern: '^AC-\\d+$', description: 'Acceptance criterion id from the ticket, e.g. `AC-2`.' });

const basis = Type.Object(
  {
    type: Type.Enum(['spec', 'standard', 'defect'], {
      description: '`spec` = violates an AC or spec section; `standard` = violates a numbered rule; `defect` = concrete input → wrong result.',
    }),
    ref: Type.Optional(Type.String({ description: 'spec: `AC-n` or `spec:<section>`; standard: the rule id, e.g. `TEST-03`, `AG-CODE-01`, or an ADR of the repo, e.g. `ADR-0004`.' })),
    scenario: Type.Optional(Type.String({ description: 'defect: the input and the wrong result it produces.' })),
  },
  { description: 'Why this is a problem. Required for blocking findings.' },
);

const finding = Type.Object({
  id: Type.Optional(Type.String({ description: 'Short id unique within the report, e.g. `S1`.' })),
  severity: Type.Enum(['blocking', 'nit'], { description: 'Only blocking findings go to the fixer.' }),
  weight: Type.Optional(
    Type.Enum(['high', 'medium', 'low'], { description: 'Required for blocking: `high` or `medium`. `low` is a nit by definition.' }),
  ),
  impact: Type.Optional(Type.String({ description: 'Required for blocking: what breaks, for whom, and how easily it is triggered.' })),
  basis: Type.Optional(basis),
  file: Type.Optional(Type.String({ description: 'Path relative to the repository root.' })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  quote: Type.Optional(Type.String({ description: 'Required for blocking: the exact code fragment at `file:line`, copied verbatim.' })),
  message: Type.String({ description: 'The problem in one or two sentences.' }),
});

const specIssue = Type.Optional(
  Type.String({ description: 'Set only when the spec itself is wrong or contradictory, so the change cannot be judged against it.' }),
);

const specCoverage = Type.Array(
  Type.Object({
    ref: acceptanceId,
    verdict: Type.Enum(['met', 'unmet', 'partial']),
    evidence: Type.String({ description: 'The test or code that shows the verdict.' }),
  }),
  { description: 'One entry for every acceptance criterion of the group.' },
);

const standardsCoverage = Type.Object({
  rules: Type.Array(Type.String(), { description: 'Ids of the rules you checked (repo standards and practice skills).' }),
  tests: Type.Array(Type.String(), { description: 'Tests added by the implementer that you assessed.' }),
});

const securityCoverage = Type.Object({
  boundaries: Type.Array(Type.String(), { minItems: 1, description: 'Trust boundaries you traced (untrusted input → where it ends up).' }),
});

const finalCoverage = Type.Object({
  checked: Type.Array(Type.String(), { minItems: 1, description: 'Cross-group concerns you checked (contracts, duplication, integration, split ACs).' }),
});

const previous = Type.Optional(
  Type.Array(
    Type.Object({
      id: Type.String({ description: 'Id of an open finding of the previous round, as listed in the prompt.' }),
      status: Type.Enum(['fixed', 'not_fixed']),
    }),
    { description: 'Review round 2+ only: one verdict for each open finding of the previous round listed in the prompt.' },
  ),
);

function reviewReport(coverage: TSchema) {
  return Type.Object({ contract, coverage, findings: Type.Array(finding), previous, spec_issue: specIssue });
}

export const reviewSchemas = {
  spec: reviewReport(specCoverage),
  standards: reviewReport(standardsCoverage),
  security: reviewReport(securityCoverage),
  final: reviewReport(finalCoverage),
};

export const implementSchema = Type.Object({
  contract,
  status: Type.Enum(['done', 'spec_issue', 'test_issue'], {
    description: '`spec_issue`: the spec is wrong or infeasible; `test_issue`: a test from write-tests is wrong. Both stop the flow for a human.',
  }),
  summary: Type.String({ description: 'What you changed, in a few sentences.' }),
  issue: Type.Optional(Type.String({ description: 'Required unless `done`: what is wrong and why.' })),
  tests_added: Type.Array(Type.String(), { description: 'Paths of test files you added or extended (not the write-tests ones).' }),
});

export const fixSchema = Type.Object({
  contract,
  findings: Type.Array(
    Type.Object({
      id: Type.String({ description: 'The finding id from the review.' }),
      status: Type.Enum(['fixed', 'not_reproduced', 'disputed', 'escalated'], {
        description:
          '`not_reproduced`: the regression test for a defect passes on the current code. ' +
          '`escalated`: the fix is beyond a local change (missing feature, redesign, wrong branch) — a human decides.',
      }),
      disputed_on: Type.Optional(Type.Enum(['finding', 'severity'], { description: 'Required when disputed: the finding itself, or only its weight.' })),
      reason: Type.Optional(Type.String({ description: 'Required unless fixed.' })),
      regression_test: Type.Optional(Type.String({ description: 'Defects: the test that reproduces the scenario.' })),
    }),
    { description: 'One entry per blocking finding you were given.' },
  ),
});

export const mergeSchema = Type.Object({
  contract,
  status: Type.Enum(['resolved', 'escalated'], {
    description: '`escalated`: the groups cannot be merged without changing the design — a human decides; leave the conflict as it is.',
  }),
  files: Type.Array(
    Type.Object({
      path: Type.String({ description: 'A file that had conflicts, relative to the repository root.' }),
      decision: Type.String({ description: 'What you kept: one group’s version (which), both combined, or new code.' }),
      rationale: Type.String({ description: 'Why — tied to the groups’ descriptions and acceptance criteria.' }),
    }),
    { description: 'One entry per conflicted file.' },
  ),
  reason: Type.Optional(Type.String({ description: 'Required when escalated: what makes the merge a design decision.' })),
});

export const writeTestsSchema = Type.Object({
  contract,
  tests: Type.Array(
    Type.Object({
      path: Type.String(),
      name: Type.String({ description: 'Test name; contains the AC id(s) it covers.' }),
      ac: Type.Array(acceptanceId, { minItems: 1 }),
    }),
    { description: 'Every acceptance criterion of the group has at least one test.' },
  ),
  stubs: Type.Array(Type.String(), { description: 'Files with minimal stubs you added so the tests compile.' }),
  already_met: Type.Optional(
    Type.Array(
      Type.Object({
        ac: acceptanceId,
        evidence: Type.String({ minLength: 1, description: 'Where the base code already does it: file and line, and why the test passes there.' }),
      }),
      { description: 'Criteria the base code already meets: their tests may pass before any implementation; the spec reviewer checks the evidence.' },
    ),
  ),
  style: Type.Optional(Type.String({ description: 'Without testing standards: the testing style you inferred from existing tests.' })),
  test_issue: Type.Optional(
    Type.Object({
      verdict: Type.Enum(['fixed', 'upheld'], { description: '`fixed`: you changed the test; `upheld`: the test is right as written.' }),
      reason: Type.String({ minLength: 1, description: 'Why, answering the implementer’s argument.' }),
    }, { description: 'Only when an implementer reported one of your tests as wrong: your answer.' }),
  ),
});

export type ImplementArtifact = Static<typeof implementSchema>;
export type FixArtifact = Static<typeof fixSchema>;
export type WriteTestsArtifact = Static<typeof writeTestsSchema>;
export type MergeArtifact = Static<typeof mergeSchema>;
