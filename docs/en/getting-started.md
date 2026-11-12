English | [Polski](../pl/getting-started.md)

# Getting started

Installation, a token-free trial and the first real flow.

## Installation

```bash
git clone https://github.com/piowyg/agentic-framework.git && cd agentic-framework
npm install
npm run build && npm link          # puts the `agentic` command on PATH

agentic doctor                     # checks config, harness CLIs, container engine — changes nothing
agentic models                     # model catalog: alias → harness, ID, efforts
agentic config show                # merged config + where each layer comes from
agentic init                       # in a service repo: .agentic/config.yaml with review.checks for the detected build + a ticket template
```

Agent sessions run in a container by default: [guides/containers.md](guides/containers.md) sets up the image and
credentials. Global and repo config: [guides/config.md](guides/config.md).

## Token-free trial

Before the first real flow, run the whole thing with `--fake`: a fake harness plays the agent, so it costs nothing.
It works in any repo with `review.checks` (it skips the write-tests stage).

```bash
agentic new "Cart limit" --fake
agentic new --fake                 # no description: paste a longer idea, end with a line containing only `.`
agentic pick --fake                # no path: paste a ticket (e.g. from Jira), end with a `.` line
agentic status                     # list of flows
agentic status cart-limit          # stages, groups, review rounds, usage
agentic resume cart-limit --fake
agentic clean --dry-run            # what old flows left behind (clones, bundles, agentic/* branches) and how much space it takes
```

At gates you pick an action: continue / revise with a note / save and pause / abort
(the ticket gate also offers: push to the tracker and finish). Resume a paused flow with `agentic resume <slug>`.
An aborted or `failed` flow asks at the end whether to clean up. Later, `agentic clean [slug]` does it: a branch with
commits that exist nowhere else is deleted only after you confirm, and audit artifacts stay.

A ticket with `status: ready` and `AC-n` criteria, pasted or from a file, goes straight to the technical grill. Any
other text (e.g. a ticket copied from a tracker) makes `pick` offer to start with the business grill: the text goes
into the flow's `idea.md`, and the grill turns it into a ticket in the framework's format.

## First real flow

The same commands without `--fake`. The whole path from installation to a PR on a real repo, with publish and
cleanup: [guides/swe.md](guides/swe.md).
