import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionArgv, ago, cut, headline, isNoFleet, parseCommand, parseSnapshot } from "../jirau/hooks/model.ts";
import { jirauFiles, render } from "../scripts/embed-jirau.ts";
import { installMod, modDir, snapshot, stateLabel, uninstallMod } from "../src/jirau.ts";
import { Store } from "../src/store.ts";
import type { Card } from "../src/types.ts";

const clock = new Date("2026-11-18T12:00:00Z");

function fleetWithCards() {
  const store = new Store(":memory:", () => clock);
  const add = (title: string) => store.add({ source: "inbox", title })!;
  const you = add("Renew the vendor? $12k");
  store.move(you.id, "you", "money: needs your signature");
  const draft = add("When is the deploy window?");
  store.move(draft.id, "you", "reply ready, waiting for your OK", { draft: "Friday 14:00 UTC." });
  const inv = add("Signup 500s");
  store.move(inv.id, "investigating", "a bug");
  const pr = add("Fix plus emails");
  store.move(pr.id, "waiting", "waiting on the PR", { waiting_kind: "pr", waiting_on: "u", pr_url: "https://github.com/a/b/pull/42" });
  const ana = add("Need Ana's numbers");
  store.move(ana.id, "waiting", "waiting on ana", { waiting_kind: "person", waiting_on: "ana", chases: 2 });
  const esc = add("Escalated one");
  store.move(esc.id, "waiting", "waiting on bob", { waiting_kind: "person", waiting_on: "bob", chases: 4, escalated: 1 });
  const done = add("Closed");
  store.move(done.id, "done", "delivered");
  return { store, ids: { you: you.id, draft: draft.id, inv: inv.id, pr: pr.id, ana: ana.id, esc: esc.id, done: done.id } };
}

describe("snapshot (what the pane reads)", () => {
  test("lane holds the human's cards plus escalated waits; active holds the rest with real states", () => {
    const { store, ids } = fleetWithCards();
    const s = snapshot(store, { fleet: "f", running: true, pausedUntil: null });
    expect(s.lane.map((c) => c.id)).toEqual([ids.you, ids.draft, ids.esc]);
    expect(s.lane.find((c) => c.id === ids.draft)!.draft).toBe("Friday 14:00 UTC.");
    expect(s.lane.find((c) => c.id === ids.esc)!.escalated).toBe(true);
    const labels = Object.fromEntries(s.active.map((c) => [c.id, c.label]));
    expect(labels[ids.inv]).toBe("investigating");
    expect(labels[ids.pr]).toBe("waiting on PR #42");
    expect(labels[ids.ana]).toBe("waiting on ana");
    expect(s.active.map((c) => c.id)).not.toContain(ids.done);
    expect(s.active.find((c) => c.id === ids.ana)!.stalled).toBe(true);
    expect(s.active.find((c) => c.id === ids.pr)!.stalled).toBe(false);
  });

  test("labels never say delivered for an open card", () => {
    const base = { attempts: 0, reason: null, waiting_kind: null, waiting_on: null, pr_url: null } as unknown as Card;
    for (const state of ["new", "gatekeeper", "investigating", "building", "delivering", "waiting", "later", "repair"] as const)
      expect(stateLabel({ ...base, state })).not.toMatch(/deliver(ed)?$|done/);
    expect(stateLabel({ ...base, state: "building", reason: "CI failed" })).toBe("fixing red CI");
  });

  test("round-trips through the pane's parser", () => {
    const { store } = fleetWithCards();
    const raw = JSON.stringify(snapshot(store, { fleet: "f", running: false, pausedUntil: new Date("2026-11-18T12:30:00Z") }));
    const s = parseSnapshot(raw);
    expect(s.lane).toHaveLength(3);
    expect(headline(s)).toBe("stopped · paused until 12:30 (usage limit)");
  });
});

describe("pane logic", () => {
  test("parses commands", () => {
    expect(parseCommand("")).toEqual({ kind: "open" });
    expect(parseCommand("refresh")).toEqual({ kind: "refresh" });
    expect(parseCommand("send 3")).toEqual({ kind: "act", verb: "send", id: 3, text: "" });
    expect(parseCommand("edit #3 Never on Fridays")).toEqual({ kind: "act", verb: "edit", id: 3, text: "Never on Fridays" });
    expect(parseCommand("edit 3").kind).toBe("error");
    expect(parseCommand("send").kind).toBe("error");
    expect(parseCommand("launch 3").kind).toBe("error");
  });
  test("argv for the CLI", () => {
    expect(actionArgv("pororoca", { verb: "decide", id: 4, text: "yes, renew" })).toEqual(["pororoca", "decide", "4", "yes, renew"]);
    expect(actionArgv("/x/pororoca", { verb: "merge", id: 4, text: "" })).toEqual(["/x/pororoca", "merge", "4"]);
  });
  test("tolerates a CLI with missing fields", () => {
    const s = parseSnapshot('{"lane":[{"id":1}],"active":[{"id":2,"state":"building"}]}');
    expect(s.lane[0]!.title).toBe("");
    expect(s.active[0]!.label).toBe("building");
    expect(s.resolvedWithoutYou).toBeNull();
  });
  test("helpers", () => {
    expect(cut("a  b\nc", 10)).toBe("a b c");
    expect(cut("abcdefghij", 5)).toBe("abcd…");
    expect(ago("2026-11-18T11:15:00Z", clock)).toBe("45m");
    expect(ago("2026-11-18T09:00:00Z", clock)).toBe("3h");
    expect(ago("2026-11-16T12:00:00Z", clock)).toBe("2d");
    expect(isNoFleet("pororoca: no /x/maloca.yaml here. Run `pororoca init` first.")).toBe(true);
  });
});

describe("install", () => {
  test("the embedded copy matches jirau/", () => {
    expect(readFileSync(join(import.meta.dir, "..", "src", "jirau-files.ts"), "utf8")).toBe(render(jirauFiles()));
  });
  test("installs into ~/.claude/skills/pororoca-jirau and uninstalls only itself", () => {
    const home = mkdtempSync(join(tmpdir(), "jirau-home-"));
    const dir = installMod(home);
    expect(dir).toBe(modDir(home));
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("pororoca-jirau");
    expect(existsSync(join(dir, "hooks", "register.tsx"))).toBe(true);
    expect(uninstallMod(home)).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    expect(uninstallMod(home)).toBeNull();
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"name":"someone-else"}');
    expect(() => uninstallMod(home)).toThrow("not the Pororoca Jirau");
  });
});
