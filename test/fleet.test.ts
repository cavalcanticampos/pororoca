import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalInbox } from "../src/adapters/inbox.ts";
import type { BuildResult, Forge } from "../src/adapters/types.ts";
import { runDemo } from "../src/demo.ts";
import { Fleet, humanLane, MAX_ATTEMPTS } from "../src/fleet.ts";
import { presetMaloca, type Maloca } from "../src/maloca.ts";
import { metrics } from "../src/metrics.ts";
import { FakeRuntime, type RunRequest, type RunResult } from "../src/runtime.ts";
import { Store } from "../src/store.ts";

const j = (o: unknown) => JSON.stringify(o);
let clock = new Date("2026-11-18T12:00:00Z");
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

type Answers = Partial<Record<RunRequest["role"], string | RunResult | ((r: RunRequest) => string | RunResult)>>;

class StubForge implements Forge {
  readonly id = "stub";
  state: "open" | "merged" | "closed" = "open";
  inflight: string[] = [];
  constructor(public result: BuildResult = { ok: true, prUrl: "https://example/pr/1", files: ["src/a.ts"] }) {}
  async build() {
    return this.result;
  }
  async inFlight() {
    return this.inflight;
  }
  async prState() {
    return this.state;
  }
}

function setup(answers: Answers, tweak: (m: Maloca) => void = () => {}, forge: StubForge | undefined = new StubForge()) {
  const dir = mkdtempSync(join(tmpdir(), "pororoca-test-"));
  const store = new Store(dir, () => clock);
  const maloca = presetMaloca("tech-lead", { id: "me" }, ["a/b"]);
  maloca["x-maloca"].autonomy.reply = "auto";
  tweak(maloca);
  const runtime = new FakeRuntime((req) => {
    const a = answers[req.role];
    if (a === undefined) return j({});
    return typeof a === "function" ? a(req) : a;
  });
  const fleet = new Fleet({ maloca, store, runtime, stateDir: dir, conversations: { inbox: new LocalInbox() }, forge });
  return { dir, store, fleet, runtime, forge };
}

const happy: Answers = {
  triage: j({ kind: "question", repo: "a/b", summary: "s" }),
  gatekeeper: j({ needs_human: false, why: "fleet can" }),
  investigator: j({ action: "reply", reply: "here you go" }),
};

beforeEach(() => {
  clock = new Date("2026-11-18T12:00:00Z");
});

describe("pipeline", () => {
  test("a question is answered and closed without the human", async () => {
    const { store, fleet } = setup(happy);
    const c = store.add({ source: "inbox", title: "q?" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
    expect(store.events(c.id).some((e) => e.kind === "sent" && e.detail!.startsWith("here you go"))).toBe(true);
    expect(metrics(store).resolvedWithoutYou).toBe(1);
  });

  test("reply level propose puts the draft in the human lane", async () => {
    const { store, fleet } = setup(happy, (m) => (m["x-maloca"].autonomy.reply = "propose"));
    const c = store.add({ source: "inbox", title: "q?" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("you");
    await fleet.humanSend(c.id);
    expect(store.get(c.id)!.state).toBe("done");
    expect(metrics(store).approvedUnchanged).toBe(1);
  });

  test("noise is closed by triage", async () => {
    const { store, fleet } = setup({ triage: j({ kind: "noise", summary: "spam" }) });
    const c = store.add({ source: "inbox", title: "win a prize" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("ignored");
  });
});

describe("gatekeeper", () => {
  test("escalates only for declared reasons", async () => {
    const { store, fleet } = setup({ ...happy, gatekeeper: j({ needs_human: true, reason: "money", why: "$" }) });
    const c = store.add({ source: "inbox", title: "pay vendor" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("you");
  });

  test("a reason outside the list is overruled: the fleet handles it", async () => {
    const { store, fleet } = setup({ ...happy, gatekeeper: j({ needs_human: true, reason: "feels important", why: "?" }) });
    const c = store.add({ source: "inbox", title: "x" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
    expect(store.events(c.id).map((e) => e.kind)).toContain("gatekeeper_overruled");
  });

  test("fail-closed: errors keep the card with the gatekeeper, then repair, never the human lane", async () => {
    const { store, fleet } = setup({ ...happy, gatekeeper: { ok: false, text: "", error: "boom" } });
    const c = store.add({ source: "inbox", title: "x" })!;
    await fleet.tick({ fetch: false });
    await fleet.tick({ fetch: false });
    expect(store.get(c.id)!.state).toBe("gatekeeper");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await fleet.tick({ fetch: false });
    expect(store.get(c.id)!.state).toBe("repair");
    expect(humanLane(store)).toHaveLength(0);
  });
});

describe("weekly-limit pause", () => {
  test("pauses the fleet, keeps the card, notifies once, resumes later", async () => {
    let limited = true;
    const { store, fleet } = setup({
      ...happy,
      triage: () => (limited ? { ok: false, text: "You've hit your weekly limit", limit: true } : j({ kind: "question", summary: "s" })),
    });
    const a = store.add({ source: "inbox", title: "a" })!;
    store.add({ source: "inbox", title: "b" });
    await fleet.tick({ fetch: false });
    await fleet.tick({ fetch: false });
    expect(fleet.pausedUntil()).not.toBeNull();
    expect(store.get(a.id)!.state).toBe("new");
    expect(store.get(a.id)!.attempts).toBe(0);
    expect(store.events().filter((e) => e.kind === "fleet_paused")).toHaveLength(1);
    limited = false;
    advance(31 * 60_000);
    await fleet.drain();
    expect(store.get(a.id)!.state).toBe("done");
    expect(store.events().some((e) => e.kind === "fleet_resumed")).toBe(true);
  });
});

describe("building", () => {
  const build: Answers = { ...happy, investigator: j({ action: "build", plan: "fix it" }) };

  test("opens a PR, delivers, waits on it, closes when merged", async () => {
    const { store, fleet, forge } = setup(build);
    const c = store.add({ source: "inbox", title: "bug", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("waiting");
    expect(store.get(c.id)!.waiting_kind).toBe("pr");
    forge!.state = "merged";
    await fleet.chase();
    expect(store.get(c.id)!.state).toBe("done");
  });

  test("a PR closed without merge goes back to investigation", async () => {
    const { store, fleet, forge } = setup(build);
    const c = store.add({ source: "inbox", title: "bug", repo: "a/b" })!;
    await fleet.drain();
    forge!.state = "closed";
    await fleet.chase();
    expect(store.get(c.id)!.state).toBe("investigating");
  });

  test("sensitive change goes to the human by default", async () => {
    const forge = new StubForge({ ok: true, prUrl: "u", files: [".github/workflows/ci.yml"] });
    const { store, fleet } = setup(build, () => {}, forge);
    const c = store.add({ source: "inbox", title: "ci", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("you");
    expect(store.get(c.id)!.reason).toContain("CI config");
  });

  test("with sensitive_change: judge, an approval lets it through", async () => {
    const forge = new StubForge({ ok: true, prUrl: "u", files: ["infra/x.tf"] });
    const { store, fleet } = setup({ ...build, judge: j({ approve: true, why: "fine" }) }, (m) => (m["x-maloca"].autonomy.sensitive_change = "judge"), forge);
    const c = store.add({ source: "inbox", title: "infra", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("waiting");
  });

  test("an additive migration is not sensitive", async () => {
    const forge = new StubForge({ ok: true, prUrl: "u", files: ["db/migrations/1.sql"], contents: { "db/migrations/1.sql": "CREATE TABLE t (id int);" } });
    const { store, fleet } = setup(build, () => {}, forge);
    const c = store.add({ source: "inbox", title: "table", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("waiting");
  });

  test("not code goes back to investigation, not to the human", async () => {
    let n = 0;
    const forge = new StubForge({ ok: true, notCode: "it is a config toggle" });
    const { store, fleet } = setup(
      { ...happy, investigator: () => (n++ === 0 ? j({ action: "build", plan: "p" }) : j({ action: "reply", reply: "toggled" })) },
      () => {},
      forge,
    );
    const c = store.add({ source: "inbox", title: "x", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
    expect(humanLane(store)).toHaveLength(0);
  });

  test("technical failures retry, then go to repair", async () => {
    const forge = new StubForge({ ok: false, error: "git exploded" });
    const { store, fleet } = setup(build, () => {}, forge);
    const c = store.add({ source: "inbox", title: "x", repo: "a/b" })!;
    for (let i = 0; i < 10; i++) await fleet.tick({ fetch: false });
    expect(store.get(c.id)!.state).toBe("repair");
    expect(store.events(c.id).filter((e) => e.kind === "retry")).toHaveLength(MAX_ATTEMPTS - 1);
  });

  test("building off sends the plan to the human", async () => {
    const { store, fleet } = setup(build, (m) => (m["x-maloca"].autonomy.open_pr = "off"));
    const c = store.add({ source: "inbox", title: "x", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("you");
  });
});

describe("work claims", () => {
  test("a whole-repo claim holds investigation", async () => {
    const { store, fleet } = setup(happy);
    store.addClaim({ repo: "a/b", owner: "ana", reason: "big refactor", hours: 2 });
    const c = store.add({ source: "inbox", title: "x", repo: "a/b" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("investigating");
    expect(store.get(c.id)!.reason).toBe("claimed: big refactor");
    advance(3 * 3_600_000);
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
  });

  test("PRs in flight are shown to the investigator", async () => {
    const forge = new StubForge();
    forge.inflight = ["open PR #9 (fix-x): fix x"];
    const { store, fleet, runtime } = setup(happy, () => {}, forge);
    store.add({ source: "inbox", title: "x", repo: "a/b" });
    await fleet.drain();
    expect(runtime.calls.find((c) => c.role === "investigator")!.prompt).toContain("open PR #9");
  });
});

describe("chaser", () => {
  const wait: Answers = { ...happy, investigator: j({ action: "wait", waiting_on: "ana", waiting_kind: "person" }) };

  test("chases after 60m, every 30m, escalates after 4 and keeps chasing", async () => {
    const { store, fleet } = setup(wait, (m) => (m["x-maloca"].autonomy.chase_people = "auto"));
    const c = store.add({ source: "inbox", title: "need ana's input" })!;
    await fleet.drain();
    await fleet.chase();
    expect(store.get(c.id)!.chases).toBe(0);
    advance(61 * 60_000);
    await fleet.chase();
    expect(store.get(c.id)!.chases).toBe(1);
    for (let i = 0; i < 4; i++) {
      advance(31 * 60_000);
      await fleet.chase();
    }
    const card = store.get(c.id)!;
    expect(card.chases).toBe(5);
    expect(card.escalated).toBe(1);
    expect(card.state).toBe("waiting");
    expect(humanLane(store).map((x) => x.id)).toContain(c.id);
    expect(store.events(c.id).filter((e) => e.kind === "sent").length).toBe(5);
  });

  test("with chasing off it tracks and escalates but sends nothing", async () => {
    const { store, fleet } = setup(wait);
    const c = store.add({ source: "inbox", title: "x" })!;
    await fleet.drain();
    advance(61 * 60_000);
    await fleet.chase();
    expect(store.events(c.id).map((e) => e.kind)).toContain("chase");
    expect(store.events(c.id).map((e) => e.kind)).not.toContain("sent");
  });
});

describe("the human", () => {
  test("edit sends the human's text, counts a correction and remembers it for the repo", async () => {
    const { store, fleet, dir, runtime } = setup(happy, (m) => (m["x-maloca"].autonomy.reply = "propose"));
    const c = store.add({ source: "inbox", title: "deploy?", repo: "a/b" })!;
    await fleet.drain();
    await fleet.humanEdit(c.id, "Never deploy on Fridays.");
    expect(store.get(c.id)!.state).toBe("done");
    expect(metrics(store).corrections).toBe(1);
    expect(readFileSync(join(dir, "decisions", "a__b.md"), "utf8")).toContain("Never deploy on Fridays.");
    store.add({ source: "inbox", title: "deploy friday?", repo: "a/b" });
    await fleet.drain();
    expect(runtime.calls.filter((c) => c.role === "investigator").at(-1)!.prompt).toContain("Never deploy on Fridays.");
  });

  test("decide hands the card back to the fleet", async () => {
    const { store, fleet } = setup({ ...happy, gatekeeper: j({ needs_human: true, reason: "money", why: "$" }) });
    const c = store.add({ source: "inbox", title: "renew?" })!;
    await fleet.drain();
    fleet.humanDecide(c.id, "yes, renew for one year");
    expect(store.get(c.id)!.state).toBe("investigating");
    expect(store.get(c.id)!.body).toContain("yes, renew for one year");
  });

  test("cannot act on cards outside the lane", async () => {
    const { store, fleet } = setup(happy);
    const c = store.add({ source: "inbox", title: "x" })!;
    expect(fleet.humanSend(c.id)).rejects.toThrow("not in your lane");
  });
});

describe("demo", () => {
  test("keeps 2 of 3 away from the human", async () => {
    const lines: string[] = [];
    const r = await runDemo({ fast: true, write: (s) => lines.push(s) });
    expect(r.lane).toBe(1);
    expect(r.resolvedWithoutYou).toBeCloseTo(2 / 3);
    expect(lines.join("\n")).toContain("needs you (money)");
  });
});

class LandingForge extends StubForge {
  ci: "pass" | "fail" | "pending" | "none" = "pending";
  merged: string[] = [];
  async checks() {
    return this.ci;
  }
  async merge(url: string) {
    this.merged.push(url);
    this.state = "merged";
    return { ok: true };
  }
}

describe("landing the PR", () => {
  const build: Answers = { ...happy, investigator: j({ action: "build", plan: "fix it" }), judge: j({ approve: true, why: "ok" }) };

  test("waits while CI is pending, merges when green (merge: judge)", async () => {
    const forge = new LandingForge();
    const { store, fleet } = setup(build, () => {}, forge);
    const c = store.add({ source: "inbox", title: "bug", repo: "a/b" })!;
    await fleet.drain();
    await fleet.chase();
    expect(store.get(c.id)!.state).toBe("waiting");
    forge.ci = "pass";
    await fleet.chase();
    expect(forge.merged).toEqual(["https://example/pr/1"]);
    expect(store.get(c.id)!.state).toBe("done");
  });

  test("red CI goes back to the builder, three times then repair", async () => {
    const forge = new LandingForge();
    forge.ci = "fail";
    const { store, fleet } = setup(build, () => {}, forge);
    const c = store.add({ source: "inbox", title: "bug", repo: "a/b" })!;
    await fleet.drain();
    await fleet.chase();
    expect(store.get(c.id)!.state).toBe("building");
    expect(store.get(c.id)!.draft).toContain("failed CI");
    for (let i = 0; i < 2; i++) {
      await fleet.drain();
      await fleet.chase();
    }
    expect(store.get(c.id)!.state).toBe("repair");
    expect(forge.merged).toEqual([]);
  });

  test("merge: propose hands the green PR to the human, who merges it", async () => {
    const forge = new LandingForge();
    forge.ci = "pass";
    const { store, fleet } = setup(build, (m) => (m["x-maloca"].autonomy.merge = "propose"), forge);
    const c = store.add({ source: "inbox", title: "bug", repo: "a/b" })!;
    await fleet.drain();
    await fleet.chase();
    expect(store.get(c.id)!.state).toBe("you");
    await fleet.humanMerge(c.id);
    expect(store.get(c.id)!.state).toBe("done");
  });

});

describe("fleet-editable allowlist", () => {
  test("a grant approved by the judge lands in the file and reaches the runtime", async () => {
    const { store, fleet, dir, runtime } = setup({
      ...happy,
      investigator: j({ action: "grant_tool", tool: "Bash(npm run lint:*)", tool_role: "builder" }),
      judge: j({ approve: true, why: "read-only lint" }),
    });
    const c = store.add({ source: "inbox", title: "let the builder run the linter" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
    const file = JSON.parse(readFileSync(join(dir, "allowlist.json"), "utf8"));
    expect(file.builder).toContain("Bash(npm run lint:*)");
    expect(runtime.calls[0]!.allowedTools).toContain("Read");
  });

  test("the judge can reject; dangerous specs never reach the judge", async () => {
    const r1 = setup({ ...happy, investigator: j({ action: "grant_tool", tool: "Bash(make:*)" }), judge: j({ approve: false, why: "too broad" }) });
    const c1 = r1.store.add({ source: "inbox", title: "x" })!;
    await r1.fleet.drain();
    expect(r1.store.get(c1.id)!.state).toBe("you");

    const r2 = setup({ ...happy, investigator: j({ action: "grant_tool", tool: "Bash(curl:*)" }), judge: j({ approve: true, why: "?" }) });
    const c2 = r2.store.add({ source: "inbox", title: "y" })!;
    await r2.fleet.drain();
    expect(r2.store.get(c2.id)!.reason).toContain("refused");
    expect(r2.runtime.calls.some((c) => c.role === "judge")).toBe(false);
  });
});

test("the judge gets the PR diff as evidence", async () => {
  const forge = new LandingForge();
  forge.ci = "pass";
  (forge as any).diff = async () => "+ return /plus/.test(x)";
  const { store, fleet, runtime } = setup({ ...happy, investigator: j({ action: "build", plan: "p" }), judge: j({ approve: true, why: "ok" }) }, () => {}, forge);
  store.add({ source: "inbox", title: "bug", repo: "a/b" });
  await fleet.drain();
  await fleet.chase();
  expect(runtime.calls.find((c) => c.role === "judge")!.prompt).toContain("+ return /plus/.test(x)");
});
