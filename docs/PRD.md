# PRD: Pororoca v0.1, a fleet that works for one person

Status: draft · Owner: Roberto Campos (@cavalcanticampos) · 2026-11-17

## 1. Problem

The people everything depends on (tech leads, managers, founders) become the bottleneck. Every request, every review and every "can you check this?" waits in their queue. AI tools help with single tasks, but the person is still the router: they read every message, decide who should act, chase whoever is holding things, and reply to everyone.

Existing tools cover half of it each:

- **Personal assistants** (Lindy, Slackbot, Asana Dash, OpenClaw) triage and draft replies, but they don't investigate, fix or ship.
- **Agent code factories** (Gas Town, OpenRig, alfred-os) ship code, but they don't speak for the person or chase other people until the work is done.

No one combines both under an **explicit autonomy policy** with a **follow-up owner** and a metric for **how much of the work no longer needs the human**.

## 2. Evidence

The design comes from a private fleet run for one tech lead since 2026. Here is one week of it:

- **Volume:** 1,377 incoming items, of which only 96 (7%) needed the human. Of 348 items that came from chat, 24 needed him.
- **Messages:** 1,143 sent on his behalf, 98.5% automatically and signed 🤖. Only 17 were sent or edited by him.
- **Delivery:** 608 PRs taken to done.
- **Chasing:** ~300 follow-ups and chases.
- **Quality gates:** about 20% of the fleet's work was rejected by its own guardian and review agents before reaching anyone.

It also failed in a way the framework must prevent. Top-priority items were marked "delivered" once they were handed to someone else, and nobody kept chasing them.

## 3. Goals for v0.1

1. **Anyone can run it.** A developer with a GitHub account and a Claude Code subscription has a working solo fleet in under 30 minutes, without Slack.
2. **Declared, not coded.** The team, the schedules, who chases whom, the autonomy levels and the escalation path all live in `maloca.yaml`.
3. **Safe by default.** The fleet starts in shadow mode and earns autonomy with evidence.
4. **One metric.** `pororoca metrics` reports the share of work resolved without the human.

### Not in v0.1

- A web dashboard (the CLI and the Jirau pane are enough).
- Hosted or SaaS operation.
- Runtimes other than Claude Code. The runtime is a port, but only one adapter ships.
- Team mode beyond the data model. The schema supports it, but v0.1 ships the solo experience.

## 4. Users

- **Primary:** a tech lead or a solo founder drowning in requests who is comfortable with a terminal and GitHub.
- **Secondary:** a small team that wants a shared fleet (team mode, after v0.1).

## 5. Concepts

| Term | Meaning |
|---|---|
| **Maloca** | A team, declared in `maloca.yaml`. Its mode is `solo` or `team`. |
| **Agent** | An autonomous Claude Code session with a role, a schedule and tools. It is not a script that asks for JSON. |
| **Card** | One unit of work: a request, an alert or an issue. |
| **Lane "You"** | The cards that truly need the human, and only those. |
| **Gatekeeper** | The only agent allowed to put a card in the human's lane. |
| **Autonomy level (alçada)** | What each kind of action may do alone, what needs the judge, and what needs the human. |
| **Chaser** | The agent that owns follow-up. Every card that waits on someone has a chaser until it closes. |
| **Jirau** | The cockpit, a Claude Code pane in the human's own session. |

## 6. Architecture

```
            ┌───────────── maloca.yaml ─────────────┐
            │ agents · schedules · autonomy · chase │
            └──────────────────┬────────────────────┘
                               │
  inbound ──► triage ──► investigate ──► build ──► deliver ──► done
     ▲          │                          │          │
     │      gatekeeper ──► lane "You" ◄────┴── judge  │
     │                                                ▼
   ports      chaser ◄──────── waiting on someone ────┘
```

The **core** is the pipeline, the gatekeeper, the autonomy levels, the chaser, the card store (SQLite) and the metric.

Everything external is a **port with adapters**:

| Port | v0.1 adapter | Later |
|---|---|---|
| Conversation (inbound and replying as you) | **Local inbox (CLI)** and **Slack** | Teams, email, Discord |
| Code forge | **GitHub** (App) | GitLab |
| Work tracker | **GitHub Issues** | Jira, Linear, custom |
| Secrets | env vars and a file vault | 1Password, Passbolt, Vault |
| Agent runtime | **Claude Code** | Codex, others |
| Scheduler | built-in daemon reading `maloca.yaml` | OpenRig as host |

An adapter is a small interface: `fetch()`, `reply(card, text, as_human)`, `link(card)`, plus capability flags. Company-specific connectors live in private packages outside this repo.

## 7. Requirements

### 7.1 `maloca.yaml`

- Compatible with the OpenRig rig spec v0.2 (`pods`, `members`, `edges`). Pororoca fields live under `x-maloca`: `mode`, `humans`, schedules, autonomy levels, chase rules and escalation.
- `pororoca maloca check` fails when:
  - the running fleet differs from the file;
  - **any card state has no chaser** (the "delivered but still waiting" hole);
  - an agent can reach the human lane without going through the gatekeeper.

### 7.2 `pororoca init`

1. Asks for the mode (solo or team) and who the human is.
2. Connects GitHub, the conversation adapter (optional) and the tracker.
3. Writes a **starter maloca with 6 agents**: gatekeeper, triage, investigator, builder, deliverer and chaser.
4. Starts in **shadow mode**: the fleet proposes but sends nothing. After N days it shows how much it would have resolved without you, and offers to switch on each autonomy level.

### 7.3 CLI

- **Setup:** `init`.
- **Fleet:** `up`, `down`, `status`.
- **Cards:** `you` (the human lane), `show N`, `send N`, `edit N <text>`, `ignore N`, `later N`.
- **Checks:** `maloca check`, `metrics`.
- Every read command accepts `--json`, so the Jirau pane and other tools build on the CLI.

### 7.4 Autonomy and safety defaults

- Autonomy levels start at **propose only**.
- Every message sent on the human's behalf is signed 🤖.
- Changes to CI config, migrations, infrastructure or secrets always go to the judge or the human.
- Secrets travel only by vault reference, never in plain text in chat, cards or PRs.
- Chasing other people is **off** until the human turns it on.

### 7.5 Jirau (cockpit)

A Claude Code plugin with a pane beside the chat:

- **Priorities on top**, from the tracker or a label.
- **The human lane.**
- **Every open priority shows its real state**: investigating, building, waiting on \<who\>, or stalled. It is never "delivered" while it is still open.

Proposed upstream to OpenRig as an operator cockpit ([openrig#3470](https://github.com/mvschwarz/openrig/issues/3470)). If it isn't accepted there, it ships here.

## 8. Milestones

| # | Delivers | Done when |
|---|---|---|
| M1 | Core, `maloca.yaml`, CLI, local inbox, GitHub forge and issues | A solo fleet fixes a real GitHub issue end to end, from the terminal only |
| M2 | Slack adapter and shadow mode | A week in shadow mode produces the "would have resolved without you" report |
| M3 | `pororoca init` and the starter maloca | A new user reaches M1 in under 30 minutes, measured with 3 people |
| M4 | Jirau plugin | The pane shows the lane and the priorities, with real states |
| M5 | Jira and Linear adapters, team mode | Two humans share one maloca |

The private fleet this came from migrates onto the core along the way and stays the first user.

## 9. Success metrics

- **Resolved without you:** the share of incoming items closed without the human. The reference fleet sits at ~93%.
- **Time to first fleet:** under 30 minutes.
- **Embarrassment rate:** messages sent on the human's behalf that they later corrected or retracted. Target: under 1%.
- **Adoption:** 3 people outside the author running a fleet for 2+ weeks.

## 10. Risks

1. **Speaking for someone is socially risky.** One public mistake can kill adoption. Mitigations are shadow mode, autonomy earned per level, the 🤖 signature and the embarrassment metric.
2. **Platforms ship "personal agents"** (Slack, Microsoft, Asana). The difference is that Pororoca builds and chases, it is open and self-hosted, and its policy is declarative.
3. **Built too much around one person.** The pattern sells (autonomy levels, chaser and the metric), not the original code. The core stays small and the specifics go into adapters.
4. **Terms of service** for acting as a user on chat platforms. Each adapter documents this, and a bot identity is supported as an alternative.
5. **Token cost.** `pororoca metrics` also reports cost per resolved item.

## 11. Open questions

- Python or TypeScript for the core? The reference fleet is Python, while OpenRig and Claude Code mods are TypeScript.
- Should OpenRig be the scheduler and host, or should Pororoca ship its own daemon and keep OpenRig compatibility?
- What is the minimum adapter interface that still lets Slack "reply as you" and a CLI inbox share one shape?
