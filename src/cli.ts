#!/usr/bin/env bun
// pororoca: the command line. Every read command accepts --json so the Jirau pane and other tools can build on it.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitHubForge, GitHubIssues } from "./adapters/github.ts";
import { LocalInbox } from "./adapters/inbox.ts";
import { realExec, type Conversation } from "./adapters/types.ts";
import { cronMatches } from "./cron.ts";
import { runDemo } from "./demo.ts";
import { doctor, watchers } from "./doctor.ts";
import { Fleet, humanLane } from "./fleet.ts";
import {
  checkMaloca,
  exportOpenRig,
  loadMaloca,
  malocaToYaml,
  PRESETS,
  presetMaloca,
  validateMaloca,
  type Maloca,
  type Preset,
} from "./maloca.ts";
import { formatMetrics, metrics } from "./metrics.ts";
import { ClaudeCodeRuntime } from "./runtime.ts";
import { Store } from "./store.ts";
import type { Card, CardState } from "./types.ts";

export const VERSION = "0.1.0-alpha.0";

type Flags = Record<string, string | boolean>;

export function parseArgs(argv: string[]): { pos: string[]; flags: Flags; rest: string } {
  const pos: string[] = [];
  const flags: Flags = {};
  let rest = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1).join(" ");
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (v !== undefined) flags[k!] = v;
      else if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(k!)) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else pos.push(a);
  }
  return { pos, flags, rest };
}

const VALUE_FLAGS = new Set(["preset", "name", "human", "github", "repo", "repos", "file", "interval", "hours", "area", "days", "owner"]);

const HELP = `pororoca ${VERSION}: a fleet of agents that works for you

Setup
  doctor [--watch]                 check everything the fleet needs (and keep watching)
  init [--preset solo-dev|tech-lead|founder] [--yes] [--repos a/b,c/d]
                                   write maloca.yaml (starts in shadow mode)
  demo [--fast]                    watch a fleet work a fake inbox, no accounts needed

Fleet
  up [--once] [--interval 60]      run the fleet (foreground; --once drains and exits)
  down                             stop a running fleet
  status [--json]                  states, pause, shadow
  shadow on|off                    shadow mode: propose only, send nothing

Cards
  inbox add <text> [--repo a/b]    put work in the local inbox
  you [--json]                     what truly needs you
  show N [--json]                  a card and its history
  send N                           approve the draft and send it
  edit N <text>                    send your text instead (counts as a correction)
  decide N <text>                  tell the fleet what to do; remembered per repo
  ignore N | later N
  outbox [--json]                  what was sent, or would have been in shadow mode
  claim <repo> [--area x] [--hours 4] -- <reason>
                                   "someone is on it": the fleet won't build there

Checks
  maloca check                     schema, chasers, gatekeeper paths
  maloca export --openrig          plain OpenRig rig.yaml
  metrics [--days 7] [--json]      share of work resolved without you
`;

function paths(flags: Flags) {
  const malocaPath = resolve(String(flags.file ?? process.env.POROROCA_MALOCA ?? "maloca.yaml"));
  const stateDir = resolve(process.env.POROROCA_HOME ?? join(dirname(malocaPath), ".pororoca"));
  return { malocaPath, stateDir };
}

function openFleet(flags: Flags, log?: (s: string) => void): { fleet: Fleet; store: Store; maloca: Maloca; stateDir: string } {
  const { malocaPath, stateDir } = paths(flags);
  const maloca = loadMaloca(malocaPath);
  const x = maloca["x-maloca"];
  const store = new Store(stateDir);
  const repos = x.github?.repos ?? [];
  const conversations: Record<string, Conversation> = { inbox: new LocalInbox() };
  if (repos.length) conversations.github = new GitHubIssues(repos, x.github?.label ?? "pororoca");
  const fleet = new Fleet({
    maloca,
    store,
    runtime: new ClaudeCodeRuntime(x.runtime?.command ?? "claude", x.runtime?.model),
    stateDir,
    conversations,
    forge: repos.length ? new GitHubForge(join(stateDir, "work")) : undefined,
    log: log ? (l) => log(`${new Date().toISOString().slice(11, 19)} ${l}`) : undefined,
  });
  return { fleet, store, maloca, stateDir };
}

const out = (s: string) => console.log(s);
const asJson = (v: unknown) => out(JSON.stringify(v, null, 2));

function cardLine(c: Card): string {
  const extra = c.waiting_on ? ` · waiting on ${c.waiting_on}` : c.reason ? ` · ${c.reason}` : "";
  return `#${c.id}  [${c.state}${c.escalated ? ", escalated" : ""}]  ${c.title}${extra}`;
}

async function ask(q: string, def: string, yes: boolean): Promise<string> {
  if (yes || !process.stdin.isTTY) return def;
  const a = prompt(`${q}${def ? ` [${def}]` : ""}`);
  return a?.trim() || def;
}

async function cmdInit(flags: Flags) {
  const { malocaPath } = paths(flags);
  if (existsSync(malocaPath) && !flags.force) throw new Error(`${malocaPath} already exists. Use --force to overwrite.`);
  const yes = !!flags.yes;
  const gitName = (await realExec(["git", "config", "user.name"]).catch(() => null))?.out.trim() || "Me";
  const ghLogin = (await realExec(["gh", "api", "user", "-q", ".login"]).catch(() => null))?.out.trim() || "";
  out("🌊 pororoca init: a solo fleet that works for you.\n");
  for (const [k, v] of Object.entries(PRESETS)) out(`  ${k.padEnd(10)} ${v}`);
  out("");
  const preset = (await ask("Preset?", String(flags.preset ?? "solo-dev"), yes)) as Preset;
  if (!(preset in PRESETS)) throw new Error(`unknown preset ${preset}`);
  const name = await ask("Your name?", String(flags.name ?? gitName), yes);
  const github = await ask("Your GitHub login?", String(flags.github ?? ghLogin), yes);
  const reposRaw = await ask("Repos the fleet works on (owner/name, comma separated, empty for none)?", String(flags.repos ?? flags.repo ?? ""), yes);
  const repos = reposRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const m = presetMaloca(preset, { id: "me", name, ...(github ? { github } : {}) }, repos, String(flags["fleet-name"] ?? "my-fleet"));
  writeFileSync(malocaPath, malocaToYaml(m));
  out(`\nWrote ${malocaPath} (${preset}). Shadow mode is on: the fleet proposes and sends nothing until you run \`pororoca shadow off\`.`);
  if (repos.length) out(`The fleet works open issues labelled "${m["x-maloca"].github!.label}" in ${repos.join(", ")}.`);
  out(`\nNext:\n  pororoca doctor\n  pororoca inbox add "something you'd like off your plate"\n  pororoca up --once\n  pororoca you`);
}

async function cmdDoctor(flags: Flags) {
  const { malocaPath, stateDir } = paths(flags);
  let command: string | undefined;
  try {
    command = loadMaloca(malocaPath)["x-maloca"].runtime?.command;
  } catch {
    /* doctor reports it */
  }
  const checks = await doctor({ malocaPath, stateDir, runtimeCommand: command });
  if (flags.json) return asJson(checks);
  for (const c of checks) {
    out(`${c.ok ? "✅" : c.optional ? "⚠️ " : "❌"} ${c.name.padEnd(16)} ${c.detail}`);
    if (!c.ok && c.fix) out(`   fix: ${c.fix}`);
  }
  const bad = checks.filter((c) => !c.ok && !c.optional);
  out(bad.length ? `\n${bad.length} problem(s) to fix.` : "\nReady. Run `pororoca up --once` to see the fleet work.");
  if (flags.watch) {
    const { store } = openFleet(flags);
    out("\nWatching (Ctrl+C to stop)…");
    for (;;) {
      const found = await watchers(store, { stateDir, dailyBudgetUsd: loadMaloca(malocaPath)["x-maloca"].budget?.daily_usd });
      out(`${new Date().toISOString().slice(11, 19)} ${found.length ? found.join(" | ") : "all quiet"}`);
      await Bun.sleep(60_000);
    }
  }
  if (bad.length) process.exitCode = 1;
}

async function cmdUp(flags: Flags) {
  const { fleet, store, maloca, stateDir } = openFleet(flags, out);
  const x = maloca["x-maloca"];
  out(`🌊 ${maloca.name}: ${Object.keys(x.agents).length} agents${fleet.shadow ? ", shadow mode (nothing is sent)" : ""}`);
  if (flags.once) {
    await fleet.drain();
    await fleet.chase();
    const lane = humanLane(store);
    out(`\nYour lane: ${lane.length}. ${lane.length ? "Run `pororoca you`." : ""}`);
    return;
  }
  const pidFile = join(stateDir, "up.pid");
  writeFileSync(pidFile, String(process.pid));
  const cleanup = () => {
    try {
      unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  const interval = Number(flags.interval ?? 60) * 1000;
  const sched = (role: string) => Object.values(x.agents).find((a) => a.role === role)?.schedule;
  let first = true;
  for (;;) {
    const now = new Date();
    const triage = sched("triage");
    const chaser = sched("chaser");
    await fleet.tick({
      fetch: first || !triage || cronMatches(triage, now),
      chase: first || !chaser || cronMatches(chaser, now),
    });
    first = false;
    await Bun.sleep(interval);
  }
}

function cmdDown(flags: Flags) {
  const { stateDir } = paths(flags);
  const pidFile = join(stateDir, "up.pid");
  if (!existsSync(pidFile)) return out("No fleet running here.");
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
    out(`Stopped fleet (pid ${pid}).`);
  } catch {
    out(`Process ${pid} was not running; cleaned up.`);
  }
  try {
    unlinkSync(pidFile);
  } catch {}
}

function cmdStatus(flags: Flags) {
  const { fleet, store, stateDir } = openFleet(flags);
  const counts: Record<string, number> = {};
  for (const c of store.list()) counts[c.state] = (counts[c.state] ?? 0) + 1;
  const pidFile = join(stateDir, "up.pid");
  let running = false;
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), 0);
      running = true;
    } catch {}
  }
  const paused = fleet.pausedUntil();
  const s = { running, shadow: fleet.shadow, pausedUntil: paused?.toISOString() ?? null, cards: counts, lane: humanLane(store).length };
  if (flags.json) return asJson(s);
  out(`fleet: ${running ? "running" : "stopped"}${s.shadow ? " · shadow mode" : ""}${paused ? ` · paused until ${s.pausedUntil}` : ""}`);
  out(`your lane: ${s.lane}`);
  const order: CardState[] = ["new", "gatekeeper", "investigating", "building", "delivering", "waiting", "you", "repair", "later", "done", "ignored"];
  for (const st of order) if (counts[st]) out(`  ${st.padEnd(14)} ${counts[st]}`);
}

export async function main(argv: string[]): Promise<void> {
  const { pos, flags, rest } = parseArgs(argv);
  const [cmd, sub, ...more] = pos;
  const n = () => {
    const id = Number(sub);
    if (!Number.isInteger(id)) throw new Error(`expected a card number, got ${sub}`);
    return id;
  };
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      return out(HELP);
    case "version":
      return out(VERSION);
    case "demo":
      await runDemo({ fast: !!flags.fast });
      return;
    case "init":
      return cmdInit(flags);
    case "doctor":
      return cmdDoctor(flags);
    case "up":
      return cmdUp(flags);
    case "down":
      return cmdDown(flags);
    case "status":
      return cmdStatus(flags);
    case "shadow": {
      const { store } = openFleet(flags);
      if (sub !== "on" && sub !== "off") throw new Error("usage: pororoca shadow on|off");
      store.setMeta("shadow", sub);
      return out(sub === "on" ? "Shadow mode on: the fleet proposes and sends nothing." : "Shadow mode off: autonomy levels in maloca.yaml now apply.");
    }
    case "inbox": {
      if (sub !== "add") throw new Error("usage: pororoca inbox add <text>");
      const text = [...more, rest].filter(Boolean).join(" ").trim();
      if (!text) throw new Error("usage: pororoca inbox add <text>");
      const { store } = openFleet(flags);
      const [title, ...body] = text.split("\n");
      const c = store.add({ source: "inbox", ext_id: `inbox-${Date.now()}`, title: title!, body: body.join("\n"), repo: (flags.repo as string) ?? null })!;
      return out(`#${c.id} added. Run \`pororoca up --once\` to work it.`);
    }
    case "you": {
      const { store } = openFleet(flags);
      const lane = humanLane(store);
      if (flags.json) return asJson(lane);
      if (!lane.length) return out("Nothing needs you. 🌊");
      for (const c of lane) {
        out(cardLine(c));
        if (c.draft) out(`     draft: ${c.draft.split("\n")[0]!.slice(0, 120)}`);
      }
      return out(`\nsend N · edit N <text> · decide N <text> · ignore N · later N`);
    }
    case "show": {
      const { store } = openFleet(flags);
      const c = store.get(n());
      if (!c) throw new Error(`no card #${sub}`);
      const events = store.events(c.id);
      if (flags.json) return asJson({ ...c, events });
      out(cardLine(c));
      if (c.body) out(`\n${c.body}`);
      if (c.draft) out(`\ndraft:\n${c.draft}`);
      if (c.pr_url) out(`\nPR: ${c.pr_url}`);
      out("\nhistory:");
      for (const e of events) out(`  ${e.at.slice(0, 19).replace("T", " ")}  ${e.kind}${e.detail ? `  ${e.detail.split("\n")[0]}` : ""}`);
      return;
    }
    case "send":
    case "edit":
    case "decide":
    case "ignore":
    case "later": {
      const { fleet } = openFleet(flags);
      const id = n();
      const text = [...more, rest].filter(Boolean).join(" ").trim();
      if (cmd === "send") await fleet.humanSend(id);
      else if (cmd === "edit") {
        if (!text) throw new Error("usage: pororoca edit N <text>");
        await fleet.humanEdit(id, text);
      } else if (cmd === "decide") {
        if (!text) throw new Error("usage: pororoca decide N <text>");
        fleet.humanDecide(id, text);
      } else if (cmd === "ignore") fleet.humanIgnore(id);
      else fleet.humanLater(id);
      return out(`#${id}: ${cmd} done.`);
    }
    case "outbox": {
      const { store } = openFleet(flags);
      const sent = store.events().filter((e) => e.kind === "sent" || e.kind === "would_send" || e.kind === "would_chase");
      if (flags.json) return asJson(sent);
      if (!sent.length) return out("Outbox is empty.");
      for (const e of sent) out(`#${e.card_id} ${e.kind === "sent" ? "🤖 sent" : `(${e.kind.replace("_", " ")})`}: ${e.detail?.split("\n")[0]}`);
      return;
    }
    case "claim": {
      if (!sub) throw new Error("usage: pororoca claim <owner/repo> [--area x] [--hours 4] -- <reason>");
      const { store } = openFleet(flags);
      if (sub === "list") return out(store.claims().map((c) => `${c.id}  ${c.repo}${c.area ? `:${c.area}` : ""}  ${c.owner} until ${c.until}  ${c.reason}`).join("\n") || "No claims.");
      if (sub === "remove") {
        store.removeClaim(Number(more[0]));
        return out("Claim removed.");
      }
      const id = store.addClaim({ repo: sub, area: (flags.area as string) ?? null, owner: String(flags.owner ?? "me"), reason: rest || "claimed", hours: Number(flags.hours ?? 4) });
      return out(`Claim ${id} on ${sub}. The fleet won't build there until it expires (\`pororoca claim remove ${id}\`).`);
    }
    case "maloca": {
      const { malocaPath } = paths(flags);
      if (sub === "check") {
        const raw = Bun.YAML.parse(readFileSync(malocaPath, "utf8"));
        const errs = validateMaloca(raw);
        const problems = errs.length ? errs : checkMaloca(raw as Maloca);
        if (!problems.length) return out("maloca.yaml: ok. Every waiting state has a chaser; only the gatekeeper reaches you.");
        for (const p of problems) out(`❌ ${p}`);
        process.exitCode = 1;
        return;
      }
      if (sub === "export" && flags.openrig) return void process.stdout.write(exportOpenRig(loadMaloca(malocaPath)));
      throw new Error("usage: pororoca maloca check | maloca export --openrig");
    }
    case "metrics": {
      const { store, fleet } = openFleet(flags);
      const m = metrics(store, Number(flags.days ?? 7), fleet.shadow);
      return flags.json ? asJson(m) : out(formatMetrics(m));
    }
    default:
      throw new Error(`unknown command ${cmd}. Run \`pororoca help\`.`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`pororoca: ${(e as Error).message}`);
    process.exit(1);
  });
}
