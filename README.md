English | [Polski](README.pl.md)

# agentic-framework

A CLI that takes AI agents from an idea to a pull request, with a human at every decision that matters.

## What you get

- **Human gates.** The ticket, the spec, the task breakdown and the final review wait for your decision; only you
  push and open the PR.
- **TDD in a sandbox.** Each task is implemented by a fresh agent session in a throwaway container, with no remote,
  no git credentials and no open network.
- **Review with a fix loop.** Two axes (spec compliance, team standards), mechanical verification of findings
  and a fixer in a loop with safeguards.
- **Harness, model and effort per stage.** Claude Code or Codex CLI, matched to the stage and the task's difficulty.
  The orchestrator is deterministic and spends no tokens itself.

## How it works

```
idea / ticket / epic
  → business grill → ticket.md         [gate]
  → technical grill → spec.md          [gate]
  → breakdown → tasks.yaml             [gate]
  → TDD implementation in a sandbox, per group (fresh session per task)
  → review on two axes (spec, standards) → fixer, in a loop with safeguards
  → final review                       [gate]
  → agentic publish (human only: secret scan → push → PR)
```

```bash
agentic new "Cart limit"           # new flow from an idea
agentic pick ticket.md             # flow from a ready ticket
agentic status cart-limit          # where the flow stands and why
agentic publish cart-limit         # secret scan, push, PR
```

## Requirements

- Node.js 22.12+ and git
- Claude Code or Codex CLI
- Podman or Docker (container sessions; `agentic setup` installs Podman)
- gitleaks (secret scan before `publish`)

## Installation

```bash
git clone https://github.com/piowyg/agentic-framework.git && cd agentic-framework
npm install && npm run build && npm link
agentic doctor
```

Next: [getting started](docs/en/getting-started.md), including a token-free run of the whole flow.

## Documentation

- [Getting started](docs/en/getting-started.md)
- [SWE guide](docs/en/guides/swe.md): from installation to a PR on a real repo
- [Concepts](docs/en/concepts.md)
- [Security](docs/en/security.md)
- [All documentation](docs/en/README.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Some skills are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
