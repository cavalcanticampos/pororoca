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

**Pre-alpha. Design phase.** The first user is the private fleet this came from, and it is being migrated into this core piece by piece. See [docs/PRD.md](docs/PRD.md).

## Concepts

- **Maloca**: a team, declared in `maloca.yaml`. A maloca is either `solo` (one human, and the fleet works for them) or `team` (several humans, each with their own lane). The format stays compatible with the [OpenRig](https://github.com/mvschwarz/openrig) rig spec v0.2 underneath, with Pororoca's extensions under `x-maloca`.
- **Jirau**: the cockpit. A Claude Code pane next to your chat that shows what is on you and what is on fire.
- **Agents** carry Amazonian names (Curupira, Boto, Iara…), but each one does a plain job: gatekeeper, triage, investigator, builder, deliverer, chaser.

## License

MIT
