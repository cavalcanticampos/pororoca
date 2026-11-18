// `pororoca doctor`: everything the fleet needs, each failure with the command that fixes it.
// `doctor --watch` runs the same checks plus watchers that turn silent failures into cards.

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { realExec, type Exec } from "./adapters/types.ts";
import { checkMaloca, loadMaloca } from "./maloca.ts";
import type { Store } from "./store.ts";
import { ACTIVE_STATES } from "./types.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  optional?: boolean;
}

export async function doctor(o: { malocaPath: string; stateDir: string; exec?: Exec; runtimeCommand?: string }): Promise<Check[]> {
  const exec = o.exec ?? realExec;
  const run = async (cmd: string[]) => {
    try {
      return await exec(cmd);
    } catch {
      return { code: 127, out: "", err: "not found" };
    }
  };
  const checks: Check[] = [];
  const claudeCmd = o.runtimeCommand ?? "claude";

  const claude = await run([claudeCmd, "--version"]);
  checks.push(
    claude.code === 0
      ? { name: "Claude Code", ok: true, detail: claude.out.trim().split("\n").pop() ?? "" }
      : { name: "Claude Code", ok: false, detail: "not found on PATH", fix: "npm install -g @anthropic-ai/claude-code && claude" },
  );

  const gh = await run(["gh", "auth", "status"]);
  checks.push(
    gh.code === 0
      ? { name: "GitHub CLI", ok: true, detail: "logged in" }
      : {
          name: "GitHub CLI",
          ok: false,
          detail: gh.code === 127 ? "gh not installed" : "not logged in",
          fix: gh.code === 127 ? "install from https://cli.github.com" : "gh auth login",
          optional: true,
        },
  );

  const git = await run(["git", "--version"]);
  checks.push(git.code === 0 ? { name: "git", ok: true, detail: git.out.trim() } : { name: "git", ok: false, detail: "not found", fix: "install git" });

  try {
    mkdirSync(o.stateDir, { recursive: true });
    accessSync(o.stateDir, constants.W_OK);
    checks.push({ name: "state directory", ok: true, detail: o.stateDir });
  } catch {
    checks.push({ name: "state directory", ok: false, detail: `${o.stateDir} is not writable`, fix: `set POROROCA_HOME to a writable folder` });
  }

  if (!existsSync(o.malocaPath)) {
    checks.push({ name: "maloca.yaml", ok: false, detail: "missing", fix: "pororoca init" });
  } else {
    try {
      const m = loadMaloca(o.malocaPath);
      const problems = checkMaloca(m);
      checks.push(
        problems.length
          ? { name: "maloca.yaml", ok: false, detail: problems.join("; "), fix: "pororoca maloca check" }
          : { name: "maloca.yaml", ok: true, detail: `${m.name}, ${Object.keys(m["x-maloca"].agents).length} agents, ${m["x-maloca"].mode}` },
      );
    } catch (e) {
      checks.push({ name: "maloca.yaml", ok: false, detail: (e as Error).message.split("\n")[0]!, fix: "pororoca maloca check" });
    }
  }
  return checks;
}

/** Watchers: small checks over the running fleet. Each finding is a line; `--watch` prints them. */
export async function watchers(store: Store, o: { exec?: Exec; stateDir: string; dailyBudgetUsd?: number }): Promise<string[]> {
  const exec = o.exec ?? realExec;
  const out: string[] = [];
  const now = store.now().getTime();

  const paused = store.getMeta("paused_until");
  if (paused && new Date(paused).getTime() > now) out.push(`fleet paused until ${paused} (usage limit)`);

  const repair = store.list(["repair"]);
  if (repair.length) out.push(`${repair.length} card(s) in the repair queue: ${repair.map((c) => `#${c.id}`).join(", ")}`);

  const stale = store.list(ACTIVE_STATES).filter((c) => now - new Date(c.updated_at).getTime() > 24 * 3_600_000);
  if (stale.length) out.push(`${stale.length} active card(s) without progress for 24h: ${stale.map((c) => `#${c.id} (${c.state})`).join(", ")}`);

  if (o.dailyBudgetUsd) {
    const since = new Date(now - 86_400_000).toISOString();
    const s = (store.db.query("SELECT COALESCE(SUM(CAST(detail AS REAL)),0) s FROM events WHERE kind='cost' AND at >= ?").get(since) as { s: number }).s;
    if (s > o.dailyBudgetUsd) out.push(`spent $${s.toFixed(2)} in 24h, over the $${o.dailyBudgetUsd} budget`);
  }

  const df = await exec(["df", "-Pk", o.stateDir]).catch(() => null);
  const line = df?.out.trim().split("\n")[1];
  const pct = line ? Number(line.split(/\s+/)[4]?.replace("%", "")) : NaN;
  if (pct >= 90) out.push(`disk ${pct}% full where the state lives`);

  const fetchErr = store.db
    .query("SELECT detail FROM events WHERE kind = 'fetch_error' AND at >= ? ORDER BY id DESC LIMIT 1")
    .get(new Date(now - 3_600_000).toISOString()) as { detail: string } | null;
  if (fetchErr) out.push(`inbox fetch failing: ${fetchErr.detail}`);
  return out;
}
