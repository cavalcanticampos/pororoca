# PRD: Pororoca v0.1, a fleet that works for one person

Status: draft · Owner: Roberto Campos (@cavalcanticampos) · 2026-11-17 · rev. 2026-11-18

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
3. **Safe by default.** Every level starts at `propose` (the fleet drafts, you approve) and is raised with evidence: the share of drafts you approved unchanged.
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
| Scheduler | built-in daemon reading `maloca.yaml` (decided, see §11) | OpenRig as host, through the same file |

An adapter is a small interface: `fetch()`, `reply(card, text, as_human)`, `link(card)`, plus capability flags. Company-specific connectors live in private packages outside this repo.

## 7. Requirements

### 7.1 `maloca.yaml`

- Compatible with the OpenRig rig spec v0.2 (`pods`, `members`, `edges`). Pororoca fields live under `x-maloca`: `mode`, `humans`, schedules, autonomy levels, chase rules and escalation.
- `pororoca maloca check` fails when:
  - the running fleet differs from the file;
  - **any card state has no chaser** (the "delivered but still waiting" hole);
  - an agent can reach the human lane without going through the gatekeeper.

### 7.2 `pororoca doctor`, `pororoca init` and `pororoca demo`

Onboarding is part of M1, not a later milestone: if a stranger can't see the fleet work in a few minutes, nobody gets to M1's real test.

**`pororoca doctor`** checks what the fleet needs before anything runs: Claude Code installed and logged in, `gh` authenticated, a writable state directory, a valid `maloca.yaml`, and the usage limits of the Claude plan. Each failed check prints the exact command that fixes it. `doctor --watch` keeps running the same checks as watchers (see §7.6).

**`pororoca demo`** runs a full fleet against a fake inbox with three sample requests, with no GitHub, Slack or Claude account. It shows triage, the gatekeeper keeping two of the three away from the human, and the metric at the end. It takes about two minutes.

**`pororoca init`**:

1. Asks for the mode (solo or team) and who the human is.
2. Connects GitHub, the conversation adapter (optional) and the tracker.
3. Writes a **starter maloca with 6 agents**: gatekeeper, triage, investigator, builder, deliverer and chaser.
4. Starts with every reply at **propose**: the fleet drafts and you approve with `send N`. `pororoca metrics` counts the drafts you approved unchanged, which is the evidence for raising a level to `auto`.
5. Offers **presets** so the first file is already close to right: `solo-dev` (GitHub only), `tech-lead` (GitHub plus chat, chasing on) and `founder` (chat first, building off). `--yes` accepts the defaults for scripts.

### 7.3 CLI

- **Setup:** `doctor`, `init`, `demo`.
- **Fleet:** `up`, `down`, `status`.
- **Cards:** `inbox add <text>` (local inbox), `you` (the human lane), `show N`, `send N`, `edit N <text>`, `ignore N`, `later N`.
- **Checks:** `maloca check`, `maloca export --openrig`, `metrics`.
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

### 7.6 Patterns from the reference fleet

The reference fleet learned these the hard way. Each one is generic (no company specifics) and each one is a requirement for the core or the starter maloca. The milestone that delivers it is in brackets.

| Pattern | What it does | Why |
|---|---|---|
| **Weekly-limit pause** [M1] | When the agent runtime reports a usage limit, the whole fleet pauses, tells the human once and requeues every card. | Without it, every agent fails at once and the human lane fills with fake "needs you" cards. |
| **Fail-closed gatekeeper** [M1] | If the gatekeeper can't judge a card (error, limit, timeout), the card waits in a "gatekeeper judging" state. It never falls into the human lane by default. | The lane must only hold what truly needs the human. |
| **Technical-failure retry** [M1] | Git errors, dead sessions and timeouts retry on their own (realign the worktree, up to 3 times), then go to the fleet's own repair queue, not to the human. | Most "stuck" cards were infrastructure, not decisions. |
| **Work claims** [M1] | Before building, the fleet checks open PRs, recent merges and manual claims ("someone is on it") for the same repo and files. A PR that already solves it turns into a reply; overlap waits. | Avoids duplicate PRs and conflicts with humans. |
| **Per-repo decision memory** [M1] | Every decision the human makes is distilled into a per-repo file that triage, investigation and build read. | The human shouldn't answer the same question twice. |
| **Additive-migration judge** [M1] | A new migration that only adds (tables, nullable columns, indexes) is not "sensitive"; destructive ones still go to the judge or the human. | Treating every migration as sensitive sent most PRs to the human. |
| **Fleet-editable allowlist** [M1] | The runtime's tool allowlist lives in a file the builder can edit, and every change goes through the judge. | The fleet must be able to grant itself a tool the human already asked for, without a human in the loop. |
| **Human takeover** [M2] | When the human types in a conversation, the fleet steps out of it for 24 hours (renewed on every message). A 🛑 reaction removes the fleet from the thread; 🆕 turns a message into a new card. | Two voices answering the same person is the fastest way to lose trust. |
| **Promises become tasks** [M2] | A reply that promises something by a time ("I'll send it tomorrow") creates a scheduled card. A watcher flags promises past due. | "Delivered" must never mean "promised". |
| **Chaser with business hours off** [M2] | The chaser starts after 60 minutes stalled and repeats every 30, any time of day, at most once per person per round; after 4 rounds without progress the card shows up for the human and chasing continues. | Measured median reply to fleet messages was 20 minutes; a 24-hour chaser was far too slow. |
| **CI sentinel** [M2] | Red CI on the default branches becomes a card on its own, grouped by workflow, ignoring bot noise. | Broken builds are found before someone asks. |
| **Skill smith** [M4] | A procedure that shows up in 3+ agent reports becomes a reusable skill, reviewed by the judge. | The fleet gets faster at recurring work without prompt tuning. |
| **Video proof** [M4] | After a UI change reaches staging, an agent records the screen doing the change and attaches the video to the card. | "Done" with proof, not "done" because the PR merged. |
| **Daily retro** [M2] | A daily autonomous session reads every human correction and every loop of the day, fixes the cause and posts "what I improved today" with before and after. | The fleet should visibly improve itself, not only when the human complains. |
| **Watchers** [M1] | Small checks that turn a silent failure into a card: spend, disk, stalled routines, permission denials, expiring credentials, lost replies. Shipped as `doctor --watch`. | Silent failures were the main cause of the human finding problems first. |

## 8. Milestones

| # | Delivers | Done when |
|---|---|---|
| M1 | Core, `maloca.yaml`, CLI, local inbox, GitHub forge and issues, `doctor`, `init` with presets, `demo`, and the M1 patterns of §7.6 | `pororoca demo` runs on a clean machine, and a solo fleet fixes a real GitHub issue end to end, from the terminal only |
| M2 | A good install (release binaries, `curl | sh`, `init` that connects GitHub and Slack) and the Slack adapter | A clean machine goes from the install line to a fleet answering a Slack message in under 15 minutes |
| M3 | Jirau plugin | The pane shows the lane and the priorities, with real states, and acting on a card from the pane works |
| M4 | Onboarding measured with real people | A new user reaches a working fleet in under 30 minutes, measured with 3 people |
| M5 | Jira and Linear adapters, team mode | Two humans share one maloca |

The private fleet this came from migrates onto the core along the way and stays the first user.

## 9. Success metrics

- **Resolved without you:** the share of incoming items closed without the human. The reference fleet sits at ~93%.
- **Time to first fleet:** under 30 minutes.
- **Human corrections:** times per week the human corrected the fleet (edited, retracted or overrode it). It should fall week over week; the daily retro reads from it.
- **Embarrassment rate:** messages sent on the human's behalf that they later corrected or retracted. Target: under 1%.
- **Adoption:** 3 people outside the author running a fleet for 2+ weeks.

## 10. Risks

1. **Speaking for someone is socially risky.** One public mistake can kill adoption. Mitigations are autonomy levels that start at propose and are raised with evidence, the 🤖 signature and the embarrassment metric.
2. **Platforms ship "personal agents"** (Slack, Microsoft, Asana). The difference is that Pororoca builds and chases, it is open and self-hosted, and its policy is declarative.
3. **Built too much around one person.** The pattern sells (autonomy levels, chaser and the metric), not the original code. The core stays small and the specifics go into adapters.
4. **Terms of service** for acting as a user on chat platforms. Each adapter documents this, and a bot identity is supported as an alternative.
5. **Token cost.** `pororoca metrics` also reports cost per resolved item.

## 11. Decisions

- **Language: TypeScript, shipped as one binary with `bun build --compile`** (2026-11-17).
  - **Footprint isn't the deciding factor.** Each agent is a Claude Code session of about 160 MB, while the whole reference orchestrator uses 28 MB. A Rust or Go core would save roughly 2% of a fleet's memory.
  - **What decides it:** Anthropic's Agent SDK ships for TypeScript and Python, not Go or Rust. Claude Code mods, including the Jirau cockpit, are TypeScript, and so is OpenRig. Slack (Bolt) and GitHub (Octokit) have official TypeScript libraries.
  - **Go's main advantage** is a single static binary, and Bun covers that: users install one executable with no Node required.

- **Scheduler and host: Pororoca's own daemon, compatible with OpenRig** (2026-11-17).
  - **Own daemon:** `pororoca up` starts a single process that reads `maloca.yaml`, runs the schedules, the pipeline and the chaser, and launches agents as Claude Code sessions. There is no crontab, tmux or OpenRig install to set up, and the roadmap doesn't depend on another project accepting changes.
  - **Compatible with OpenRig:**
    - `maloca.yaml` is an OpenRig rig spec v0.2 underneath, with Pororoca fields under `x-maloca`. OpenRig's RigSpec currently rejects unknown keys at every level, so `pororoca export --openrig` writes a plain `rig.yaml`. We will also propose upstream that the RigSpec accept and keep `x-*` keys.
    - The card store maps onto OpenRig's queue model: states, human-gate and "waiting on". A future adapter can therefore mirror cards to an OpenRig queue.
    - The Jirau cockpit can read either one.
  - **Rule:** nothing in the core may assume it is the only host. Anything OpenRig already does well (seats, handover, restore) is used through the adapter, not rebuilt.

- **Adapter contracts** (2026-11-17), specified in [spec/adapters](https://cavalcanticampos.github.io/pororoca/spec/adapters.html):
  - **Conversation:** one interface for both Slack and the CLI inbox. "Speaks as you" is a capability flag, and the envelopes mirror OpenRig's Relay gateway v1 in push or pull mode.
  - **Humans:** mirror OpenRig's human registry.
  - **Card states:** mirror OpenRig's queue item states. A card waiting on an outside person is `blocked`, never `done`.
  - **Agent runtime:** follows OpenRig's harness and runner contract, and its conformance check is our test.
- **OpenRig's Slack app is bot-only** and "never answers as the person". Replying as the human is therefore both Pororoca's difference and its main risk (see §10.1 and §10.4).

- **No shadow mode** (2026-11-18). The `propose` level already keeps every reply behind the human's OK, and the reference fleet never needed a second lock. The evidence for raising a level is the share of drafts approved unchanged. Focus is the basics done well: install, the main integrations and the Jirau cockpit.
- **Onboarding moves into M1** (2026-11-18). `doctor`, `init` with presets and `demo` ship with the core, because the first thing a stranger needs is to see the fleet work. M3 keeps the measured goal (30 minutes, 3 people).

## 12. Open questions

- None blocking M1.
