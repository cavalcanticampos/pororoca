# Pororoca

**A fleet of AI agents that works for one person, so that person stops being the bottleneck.**

> *Pororoca* is the tidal bore of the Amazon: the river meets the sea and rises into a wave nobody holds back.

Most multi-agent frameworks answer *"how does a team of agents write code?"*. Pororoca answers a different question:

> **How does a busy person (a tech lead, a manager, a founder) get taken off the critical path of everything that lands on them?**

A Pororoca fleet:

- **filters**: a gatekeeper decides what really needs you and what the fleet can handle;
- **does the work**: it triages, investigates, builds the fix and opens the PR, then sees it through to production;
- **speaks for you, within limits you declare**: routine replies go out on their own and are signed 🤖, sensitive changes go to a judge agent, and real decisions come back to you;
- **chases until done**: the fleet follows up with the people and agents holding work, and doesn't stop at "handed off";
- **measures one thing**: the share of incoming work resolved **without you**.

## Why

This started as a personal fleet run by one tech lead. Over one week it handled:

| | |
|---|---|
| Items that reached the fleet | 1,377 |
| Items that needed the human | **96 (7%)** |
| Messages sent on the human's behalf | 1,143, of which **98.5% went out automatically** |
| PRs taken to done | 608 |
| Follow-ups and chases | ~300 |

The market splits in two. Personal assistants triage and reply, but don't build. Code factories build, but don't talk to people for you or chase anyone. Pororoca joins the two halves under one autonomy policy.

**Site:** https://cavalcanticampos.github.io/pororoca/

## Status

**Pre-alpha.** Milestone M1 (core, CLI, local inbox, GitHub) is done: a fleet takes a labelled GitHub issue to a merged PR on its own. Next: a one-line install with release binaries, the Slack adapter and the Jirau cockpit. The first user is the private fleet this came from, and it is being migrated into this core piece by piece. See [docs/PRD.md](docs/PRD.md).

## Try it

You need [Bun](https://bun.sh) 1.3+. There is no release binary yet.

```sh
git clone https://github.com/cavalcanticampos/pororoca && cd pororoca
bun install
bun src/cli.ts demo          # a fleet working a fake inbox: no GitHub, Slack or Claude account
bun run build                # one binary at dist/pororoca
```

With [Claude Code](https://docs.anthropic.com/claude-code) logged in:

```sh
pororoca doctor                              # checks Claude Code, gh, git, state dir, maloca.yaml
pororoca init --preset solo-dev              # writes maloca.yaml; replies wait for your OK
pororoca inbox add "why is the signup test flaky?"
pororoca up --once                           # work the inbox once and exit (up = keep running)
pororoca you                                 # only what truly needs you
pororoca metrics                             # share of work resolved without you
```

A new fleet starts at `propose`: every reply waits for your OK in `pororoca you`. `pororoca metrics` counts how many drafts you approved unchanged; when that is high, raise `autonomy.reply` to `auto`. Each agent call is a Claude Code session, so set `x-maloca.runtime.model` if you want a cheaper model for the fleet.

| Command | |
|---|---|
| `doctor [--watch]` | Checks, each failure with its fix; `--watch` adds watchers (repair queue, stalled cards, spend, disk, pause) |
| `init [--preset] [--yes]` | `solo-dev`, `tech-lead` or `founder` |
| `demo [--fast]` | Fake inbox, scripted runtime |
| `up [--once]` · `down` · `status` | Run the fleet |
| `inbox add <text>` | Local inbox |
| `you` · `show N` · `send N` · `edit N <text>` · `decide N <text>` · `merge N` · `ignore N` · `later N` | Your lane |
| `allowlist` | Tools each agent may use; the fleet adds narrow ones, the judge approves |
| `claim <repo> -- <reason>` | "Someone is on it": the fleet won't build there |
| `maloca check` · `maloca export --openrig` | Holes in the chase, paths around the gatekeeper; plain OpenRig rig.yaml |
| `metrics [--json]` | Resolved without you, corrections, cost per card |

## Concepts

- **Maloca**: a team, declared in `maloca.yaml`. A maloca is either `solo` (one human, and the fleet works for them) or `team` (several humans, each with their own lane). The format stays compatible with the [OpenRig](https://github.com/mvschwarz/openrig) rig spec v0.2 underneath, with Pororoca's extensions under `x-maloca`.
- **Jirau**: the cockpit. A Claude Code pane next to your chat that shows what is on you and what is on fire.
- **Agents** carry Amazonian names (Curupira, Boto, Iara…), but each one does a plain job: gatekeeper, triage, investigator, builder, deliverer, chaser.

## License

MIT
