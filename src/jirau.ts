// `pororoca jirau`: the data the Jirau pane draws, and installing the pane into Claude Code.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { humanLane } from "./fleet.ts";
import { JIRAU_FILES } from "./jirau-files.ts";
import { metrics } from "./metrics.ts";
import type { Store } from "./store.ts";
import { ACTIVE_STATES, type Card } from "./types.ts";

export const MOD_NAME = "pororoca-jirau";

/** Claude Code loads user mods from folders under ~/.claude/skills that hold a .claude-plugin manifest. */
export function modDir(home = process.env.HOME || homedir()): string {
  return join(home, ".claude", "skills", MOD_NAME);
}

const STALL_MS = 2 * 3_600_000;

/** A card's real state in words. Open cards are never "delivered". */
export function stateLabel(c: Card): string {
  switch (c.state) {
    case "new":
      return "triaging";
    case "gatekeeper":
      return c.attempts ? "gatekeeper retrying" : "gatekeeper judging";
    case "investigating":
      return c.reason?.startsWith("claimed:") ? "held by a claim" : "investigating";
    case "building":
      return c.reason === "CI failed" ? "fixing red CI" : "building";
    case "delivering":
      return "delivering";
    case "waiting": {
      if (c.waiting_kind === "pr") {
        const n = c.pr_url?.match(/\/pull\/(\d+)/)?.[1];
        return n ? `waiting on PR #${n}` : "waiting on a PR";
      }
      return `waiting on ${c.waiting_on ?? "someone"}`;
    }
    case "later":
      return "parked";
    case "repair":
      return "in repair";
    default:
      return c.state;
  }
}

export interface Snapshot {
  fleet: string;
  running: boolean;
  pausedUntil: string;
  repair: number;
  lane: { id: number; title: string; reason: string; draft: string; pr: string; escalated: boolean }[];
  active: { id: number; title: string; state: string; label: string; stalled: boolean; since: string }[];
  metrics: { resolvedWithoutYou: number | null; corrections: number; neededYou: number };
  at: string;
}

export function snapshot(store: Store, o: { fleet: string; running: boolean; pausedUntil: Date | null }): Snapshot {
  const now = store.now().getTime();
  const lane = humanLane(store);
  const laneIds = new Set(lane.map((c) => c.id));
  const open = store.list([...ACTIVE_STATES, "waiting", "repair"]).filter((c) => !laneIds.has(c.id));
  const m = metrics(store, 7);
  return {
    fleet: o.fleet,
    running: o.running,
    pausedUntil: o.pausedUntil?.toISOString() ?? "",
    repair: store.list(["repair"]).length,
    lane: lane.map((c) => ({
      id: c.id,
      title: c.title,
      reason: c.reason ?? "",
      draft: c.draft ?? "",
      pr: c.pr_url ?? "",
      escalated: !!c.escalated,
    })),
    active: open.map((c) => ({
      id: c.id,
      title: c.title,
      state: c.state,
      label: stateLabel(c),
      // a waiting card stalls once the chaser has had to nudge; anything else when it has not moved for 2h
      stalled: c.state === "repair" || (c.state === "waiting" ? c.chases > 0 : now - Date.parse(c.updated_at) > STALL_MS),
      since: c.updated_at,
    })),
    metrics: { resolvedWithoutYou: m.resolvedWithoutYou, corrections: m.corrections, neededYou: m.neededYou },
    at: store.now().toISOString(),
  };
}

export function installMod(home?: string): string {
  const dir = modDir(home);
  for (const [rel, body] of Object.entries(JIRAU_FILES)) {
    const f = join(dir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  return dir;
}

export function uninstallMod(home?: string): string | null {
  const dir = modDir(home);
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return null;
  // only remove a folder that really is this mod
  if (!readFileSync(manifest, "utf8").includes(`"${MOD_NAME}"`)) throw new Error(`${dir} is not the Pororoca Jirau; leaving it alone`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
