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

## Install

Linux and macOS (Windows: WSL):

```sh
curl -fsSL https://cavalcanticampos.github.io/pororoca/install.sh | sh
```

One binary, checked against the release's SHA-256, in `~/.local/bin`. Run the same line to update. From source: `bun install && bun run build` gives `dist/pororoca`.

## Start

```sh
pororoca demo                                # a fleet working a fake inbox: no accounts needed
pororoca doctor                              # Claude Code, gh, git; each failure with its fix
mkdir my-fleet && cd my-fleet
pororoca init                                # asks for a preset, your repos and (optionally) Slack
pororoca up                                  # run the fleet; `up --once` works the inbox once and exits
pororoca you                                 # only what truly needs you
pororoca metrics                             # share of work resolved without you
```

The fleet needs [Claude Code](https://docs.anthropic.com/claude-code) logged in; each agent call is a Claude Code session (set `x-maloca.runtime.model` for a cheaper model). Replies start at `propose`: each one waits for your OK in `pororoca you`. `pororoca metrics` counts the drafts you approved unchanged; when that is high, raise `autonomy.reply` to `auto`.

### GitHub

`pororoca connect github --repos you/app,you/api` checks your access and creates the `pororoca` label. Label an issue and the fleet takes it: triage, investigation, a PR with tests, green CI, the judge reads the diff, merge, issue closed.

### Slack

1. `pororoca connect slack --manifest > slack.yaml`, then at https://api.slack.com/apps choose *Create New App → From a manifest* and paste it.
2. Install the app to your workspace and copy the **User OAuth Token** (`xoxp-…`).
3. `pororoca connect slack --token xoxp-…`

With a user token the fleet reads your DMs, group DMs and mentions, and replies as you, signed 🤖. If you answer first, it stays quiet. A bot token (`xoxb-…`) makes it reply as the app instead. The token is saved in `.pororoca/secrets.env` (mode 600), never in `maloca.yaml`.

| Command | |
|---|---|
| `connect github --repos a/b` · `connect slack --token xoxp-…` | Test and save each connection |
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
