// The pipeline: triage -> gatekeeper -> investigate -> build -> deliver -> (waiting -> chaser) -> done.

import {
  parseVerdict,
  prompts,
  type GateVerdict,
  type InvestigateVerdict,
  type JudgeVerdict,
  type TriageVerdict,
} from "./agents.ts";
import { SIGNATURE, type Conversation, type Forge } from "./adapters/types.ts";
import { readDecisions, recordDecision } from "./decisions.ts";
import { agentName, parseDuration, type ChaseRule, type Maloca } from "./maloca.ts";
import type { RunResult, Runtime } from "./runtime.ts";
import { classify } from "./sensitive.ts";
import type { Store } from "./store.ts";
import { ACTIVE_STATES, type Card, type Level, type Role } from "./types.ts";

export const MAX_ATTEMPTS = 3;
export const PAUSE_MS = 30 * 60_000;

export interface FleetOptions {
  maloca: Maloca;
  store: Store;
  runtime: Runtime;
  stateDir: string;
  conversations: Record<string, Conversation>;
  forge?: Forge;
  /** Called on every notable step, for `up` logs and the demo narration. */
  log?: (line: string, card?: Card) => void;
}

export class Fleet {
  constructor(private o: FleetOptions) {}

  private get x() {
    return this.o.maloca["x-maloca"];
  }
  private get store() {
    return this.o.store;
  }
  private now(): Date {
    return this.store.now();
  }
  private log(line: string, card?: Card) {
    this.o.log?.(line, card);
  }
  get shadow(): boolean {
    const forced = this.store.getMeta("shadow");
    if (forced !== null) return forced === "on";
    return this.x.shadow?.enabled ?? true;
  }

  // ---------- pause (pattern: weekly-limit pause) ----------

  pausedUntil(): Date | null {
    const v = this.store.getMeta("paused_until");
    if (!v) return null;
    const d = new Date(v);
    return d > this.now() ? d : null;
  }

  private pause(why: string) {
    const until = new Date(this.now().getTime() + PAUSE_MS);
    this.store.setMeta("paused_until", until.toISOString());
    if (!this.store.getMeta("paused_notified")) {
      this.store.setMeta("paused_notified", "1");
      this.store.event(0, "fleet_paused", why);
      this.log(`fleet paused until ${until.toISOString()}: ${why}. Every card stays where it is.`);
    }
  }

  // ---------- running agents ----------

  private agent(role: Role) {
    return Object.entries(this.x.agents).find(([, a]) => a.role === role)?.[0] ?? role;
  }

  /** Runs an agent. Returns null when the card must stay where it is (limit or technical failure). */
  private async call(card: Card, role: Role, prompt: string): Promise<RunResult | null> {
    const res = await this.o.runtime.run({ agent: this.agent(role), role, prompt });
    if (res.costUsd) this.store.event(card.id, "cost", String(res.costUsd));
    if (res.limit) {
      this.pause(res.error ?? "usage limit");
      return null;
    }
    if (!res.ok) {
      this.technicalFailure(card, res.error ?? "agent failed");
      return null;
    }
    return res;
  }

  /** Pattern: technical failures retry on their own, then go to the fleet's repair queue, never to the human. */
  private technicalFailure(card: Card, why: string) {
    const attempts = card.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.store.move(card.id, "repair", `${card.state}: ${why}`, { attempts });
      this.log(`#${card.id} failed ${attempts} times in ${card.state}; moved to the fleet's repair queue`, card);
    } else {
      this.store.patch(card.id, { attempts });
      this.store.event(card.id, "retry", `${card.state}: ${why}`);
    }
  }

  private ok(card: Card) {
    if (card.attempts) this.store.patch(card.id, { attempts: 0 });
  }

  // ---------- the loop ----------

  async tick(opts: { fetch?: boolean; chase?: boolean } = {}): Promise<void> {
    if (this.pausedUntil()) return;
    if (this.store.getMeta("paused_notified")) {
      this.store.setMeta("paused_notified", null);
      this.store.event(0, "fleet_resumed");
      this.log("fleet resumed");
    }
    if (opts.fetch !== false) await this.fetch();
    for (const card of this.store.list(ACTIVE_STATES)) {
      if (this.pausedUntil()) return;
      await this.step(card);
    }
    if (opts.chase !== false) await this.chase();
  }

  /** Runs ticks until no active card moves. Used by `up --once` and the demo. */
  async drain(maxTicks = 20): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      const before = JSON.stringify(this.store.list(ACTIVE_STATES).map((c) => [c.id, c.state, c.attempts]));
      await this.tick({ fetch: i === 0, chase: false });
      const after = JSON.stringify(this.store.list(ACTIVE_STATES).map((c) => [c.id, c.state, c.attempts]));
      if (before === after || this.pausedUntil()) break;
    }
  }

  async fetch(): Promise<void> {
    for (const conv of Object.values(this.o.conversations)) {
      try {
        for (const i of await conv.fetch()) {
          const c = this.store.add({ source: conv.id, ext_id: i.ext_id, title: i.title, body: i.body, repo: i.repo });
          if (c) this.log(`#${c.id} arrived from ${conv.id}: ${c.title}`, c);
        }
      } catch (e) {
        this.store.event(0, "fetch_error", `${conv.id}: ${(e as Error).message}`);
      }
    }
  }

  async step(card: Card): Promise<void> {
    switch (card.state) {
      case "new":
        return this.triage(card);
      case "gatekeeper":
        return this.gate(card);
      case "investigating":
        return this.investigate(card);
      case "building":
        return this.build(card);
      case "delivering":
        return this.deliver(card);
    }
  }

  private async triage(card: Card) {
    const res = await this.call(card, "triage", prompts.triage(card, this.x.github?.repos ?? []));
    if (!res) return;
    const v = parseVerdict<TriageVerdict>(res.text);
    if (!v) return this.technicalFailure(card, "triage gave no verdict");
    this.ok(card);
    if (v.kind === "noise") {
      this.store.move(card.id, "ignored", `noise: ${v.summary}`, { kind: v.kind });
      return this.log(`#${card.id} ${this.name("triage")}: noise, closed`, card);
    }
    this.store.move(card.id, "gatekeeper", v.summary, { kind: v.kind, repo: card.repo ?? v.repo ?? null });
    this.log(`#${card.id} ${this.name("triage")}: ${v.kind}. ${v.summary}`, card);
  }

  /** Fail-closed: if the gatekeeper can't judge, the card waits here. It never falls into the human lane by default. */
  private async gate(card: Card) {
    const reasons = this.x.escalation.only_for;
    const res = await this.call(card, "gatekeeper", prompts.gatekeeper(card, reasons, readDecisions(this.o.stateDir, card.repo)));
    if (!res) return;
    const v = parseVerdict<GateVerdict>(res.text);
    if (!v) return this.technicalFailure(card, "gatekeeper gave no verdict");
    this.ok(card);
    if (v.needs_human && v.reason && reasons.includes(v.reason)) {
      this.store.move(card.id, "you", `${v.reason}: ${v.why}`);
      return this.log(`#${card.id} ${this.name("gatekeeper")}: needs you (${v.reason}). ${v.why}`, card);
    }
    if (v.needs_human) this.store.event(card.id, "gatekeeper_overruled", `"${v.reason}" is not an escalation reason`);
    this.store.move(card.id, "investigating", v.why);
    this.log(`#${card.id} ${this.name("gatekeeper")}: the fleet handles it. ${v.why}`, card);
  }

  private async investigate(card: Card) {
    const claims = card.repo ? this.store.claims(card.repo) : [];
    const whole = claims.find((c) => !c.area);
    if (whole) {
      if (card.reason !== `claimed: ${whole.reason}`) this.store.patch(card.id, { reason: `claimed: ${whole.reason}` });
      return;
    }
    const inFlight = card.repo && this.o.forge ? await this.o.forge.inFlight(card.repo) : [];
    const claimText = [...claims.map((c) => `claim by ${c.owner} on ${c.area}: ${c.reason}`), ...inFlight].join("\n");
    const res = await this.call(card, "investigator", prompts.investigator(card, readDecisions(this.o.stateDir, card.repo), claimText));
    if (!res) return;
    const v = parseVerdict<InvestigateVerdict>(res.text);
    if (!v) return this.technicalFailure(card, "investigator gave no verdict");
    this.ok(card);
    const who = this.name("investigator");
    switch (v.action) {
      case "reply":
        this.store.move(card.id, "delivering", "reply ready", { draft: v.reply ?? "" });
        return this.log(`#${card.id} ${who}: answer found`, card);
      case "build": {
        const level = this.x.autonomy.open_pr;
        if (!card.repo || !this.o.forge || level === "off" || level === "human") {
          this.store.move(card.id, "you", "needs a code change and building is off for this fleet", { draft: v.plan ?? "" });
          return this.log(`#${card.id} ${who}: needs code, building is off. Sent to you.`, card);
        }
        this.store.move(card.id, "building", "plan ready", { draft: v.plan ?? "" });
        return this.log(`#${card.id} ${who}: needs a fix. Plan: ${(v.plan ?? "").slice(0, 80)}`, card);
      }
      case "wait":
        this.store.move(card.id, "waiting", `waiting on ${v.waiting_on}`, {
          waiting_on: v.waiting_on ?? "someone",
          waiting_kind: v.waiting_kind ?? "person",
          draft: v.reply ?? null,
        });
        return this.log(`#${card.id} ${who}: waiting on ${v.waiting_on}. ${this.name("chaser")} owns it now.`, card);
      default:
        this.store.move(card.id, "done", "nothing left to do");
        return this.log(`#${card.id} ${who}: nothing to do, closed`, card);
    }
  }

  private async build(card: Card) {
    const forge = this.o.forge!;
    const plan = card.draft ?? "";
    const r = await forge.build(card, plan, prompts.builder(card, plan, readDecisions(this.o.stateDir, card.repo)), this.o.runtime, this.agent("builder"));
    if (r.costUsd) this.store.event(card.id, "cost", String(r.costUsd));
    if (r.limit) return this.pause(r.error ?? "usage limit");
    if (!r.ok) return this.technicalFailure(card, r.error ?? "build failed");
    this.ok(card);
    const who = this.name("builder");
    if (r.alreadyDone) {
      this.store.move(card.id, "delivering", "already solved", { draft: `This is already solved by ${r.alreadyDone}.` });
      return this.log(`#${card.id} ${who}: already solved by ${r.alreadyDone}`, card);
    }
    if (r.notCode) {
      this.store.move(card.id, "investigating", `not code: ${r.notCode}`);
      return this.log(`#${card.id} ${who}: not a code change (${r.notCode}); back to investigation`, card);
    }
    const s = classify(r.files ?? [], r.contents ?? {});
    if (s.sensitive) {
      const level = this.x.autonomy.sensitive_change;
      const what = `PR ${r.prUrl} touches ${s.reasons.join(", ")}`;
      if (level === "judge" && (await this.judge(card, what))) {
        this.log(`#${card.id} ${this.name("judge")}: approved sensitive change`, card);
      } else {
        this.store.move(card.id, "you", `sensitive change: ${s.reasons.join(", ")}`, { pr_url: r.prUrl ?? null });
        return this.log(`#${card.id} ${who}: opened ${r.prUrl}, sensitive (${s.reasons.join(", ")}). Sent to you.`, card);
      }
    }
    this.store.move(card.id, "delivering", "PR opened", { pr_url: r.prUrl ?? null, draft: `I opened a fix: ${r.prUrl}` });
    this.log(`#${card.id} ${who}: opened ${r.prUrl}`, card);
  }

  private async judge(card: Card, what: string): Promise<boolean> {
    const res = await this.call(card, "judge", prompts.judge(card, what));
    const v = res ? parseVerdict<JudgeVerdict>(res.text) : null;
    this.store.event(card.id, "judge", v ? `${v.approve ? "approved" : "rejected"}: ${v.why}` : "no verdict");
    return !!v?.approve;
  }

  private async deliver(card: Card) {
    const level: Level = this.x.autonomy.reply;
    const draft = card.draft ?? "";
    if (draft && level !== "off") {
      if (this.shadow) {
        this.store.event(card.id, "would_send", draft);
        this.store.patch(card.id, { shadow: 1 });
        this.log(`#${card.id} ${this.name("deliverer")}: (shadow) would send: ${draft.slice(0, 90)}`, card);
      } else if (level === "auto" || (level === "judge" && (await this.judge(card, `send this reply: ${draft}`)))) {
        await this.send(card, draft);
        this.log(`#${card.id} ${this.name("deliverer")}: sent 🤖`, card);
      } else {
        this.store.move(card.id, "you", "reply ready, waiting for your OK");
        return this.log(`#${card.id} ${this.name("deliverer")}: reply ready for your OK`, card);
      }
    }
    this.afterDelivery(this.store.get(card.id)!);
  }

  private afterDelivery(card: Card) {
    if (card.pr_url) this.store.move(card.id, "waiting", "waiting on the PR", { waiting_on: card.pr_url, waiting_kind: "pr" });
    else if (card.waiting_on) this.store.move(card.id, "waiting", `waiting on ${card.waiting_on}`);
    else this.store.move(card.id, "done", "delivered");
  }

  private async send(card: Card, text: string) {
    const conv = this.o.conversations[card.source];
    if (!conv) throw new Error(`no conversation adapter for ${card.source}`);
    await conv.reply(card, text);
    this.store.event(card.id, "sent", text + SIGNATURE);
  }

  // ---------- chaser ----------

  async chase(): Promise<void> {
    const now = this.now().getTime();
    for (const card of this.store.list(["waiting"])) {
      if (card.waiting_kind === "pr" && card.pr_url && this.o.forge?.prState) {
        const st = await this.o.forge.prState(card.pr_url);
        if (st === "merged") {
          this.store.move(card.id, "done", "PR merged");
          this.log(`#${card.id} ${this.name("chaser")}: PR merged, closed`, card);
          continue;
        }
        if (st === "closed") {
          // pattern: a PR closed without merge goes back to investigation, it is not "done"
          this.store.move(card.id, "investigating", "PR closed without merge", { pr_url: null });
          continue;
        }
      }
      const rule: ChaseRule | undefined =
        card.waiting_kind === "pr" ? this.x.chase.waiting_on_pr : this.x.chase.waiting_on_person;
      if (!rule) continue;
      const since = new Date(card.last_chase ?? card.updated_at).getTime();
      const due = card.last_chase ? parseDuration(rule.every) : parseDuration(rule.after);
      if (now - since < due) continue;
      const chases = card.chases + 1;
      const text = `Following up: this is still waiting on ${card.waiting_on}. ${card.title}`;
      const level = this.x.autonomy.chase_people;
      const live = card.waiting_kind === "person" && !this.shadow && (level === "auto" || level === "judge");
      if (live) await this.send(card, text);
      else this.store.event(card.id, "would_chase", text);
      this.store.patch(card.id, { chases, last_chase: this.now().toISOString() });
      this.store.event(card.id, "chase", `${chases}/${rule.max}`);
      // pattern: after max rounds the card shows up for the human, and chasing continues
      if (chases >= rule.max && !card.escalated) {
        this.store.patch(card.id, { escalated: 1 });
        this.store.event(card.id, "escalated", `${chases} chases without progress`);
        this.log(`#${card.id} ${this.name("chaser")}: ${chases} chases without progress, now visible to you`, card);
      }
    }
  }

  // ---------- the human ----------

  /** Approve the draft as is. */
  async humanSend(id: number): Promise<void> {
    const card = this.mustBeYours(id);
    if (!card.draft) throw new Error(`#${id} has no draft. Use \`pororoca decide ${id} <text>\` to tell the fleet what to do.`);
    await this.send(card, card.draft);
    this.store.event(id, "human_sent");
    this.afterDelivery(this.store.get(id)!);
  }

  /** Correct the draft and send it. Counts as a correction and becomes a decision for the repo. */
  async humanEdit(id: number, text: string): Promise<void> {
    const card = this.mustBeYours(id);
    this.store.patch(id, { draft: text });
    this.store.event(id, "correction", `draft edited`);
    recordDecision(this.o.stateDir, card.repo, `On "${card.title}", the human replied instead: ${text}`, this.now());
    await this.send(this.store.get(id)!, text);
    this.store.event(id, "human_sent");
    this.afterDelivery(this.store.get(id)!);
  }

  /** Give the fleet a decision and hand the card back. The decision is remembered for the repo. */
  humanDecide(id: number, text: string): void {
    const card = this.mustBeYours(id);
    recordDecision(this.o.stateDir, card.repo, `On "${card.title}": ${text}`, this.now());
    this.store.event(id, "human_decided", text);
    this.store.move(id, "investigating", "human decided", { body: `${card.body}\n\nDecision from the human: ${text}`, escalated: 0 });
  }

  humanIgnore(id: number): void {
    this.mustExist(id);
    this.store.move(id, "ignored", "ignored by the human");
    this.store.event(id, "human_ignored");
  }

  humanLater(id: number): void {
    this.mustExist(id);
    this.store.move(id, "later", "parked by the human");
  }

  private mustExist(id: number): Card {
    const c = this.store.get(id);
    if (!c) throw new Error(`no card #${id}`);
    return c;
  }

  private mustBeYours(id: number): Card {
    const c = this.mustExist(id);
    if (c.state !== "you" && !c.escalated) throw new Error(`#${id} is ${c.state}, not in your lane`);
    return c;
  }

  private name(role: Role) {
    return agentName(this.o.maloca, role);
  }
}

/** The human lane: cards in `you` plus waiting cards the chaser escalated. */
export function humanLane(store: Store): Card[] {
  return [...store.list(["you"]), ...store.list(["waiting"]).filter((c) => c.escalated)];
}
