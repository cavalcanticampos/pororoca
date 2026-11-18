// maloca.yaml: an OpenRig rig spec v0.2 underneath, with Pororoca fields under `x-maloca`.

import { existsSync, readFileSync } from "node:fs";
import { validCron } from "./cron.ts";
import type { Level, Mode, Role } from "./types.ts";

export interface Member {
  id: string;
  runtime?: string;
  [k: string]: unknown;
}

export interface Pod {
  id: string;
  members: Member[];
  [k: string]: unknown;
}

export interface Edge {
  from: string;
  to: string;
  kind?: string;
  [k: string]: unknown;
}

export interface Human {
  id: string;
  name?: string;
  github?: string;
}

export interface AgentDecl {
  name?: string;
  role: Role;
  schedule?: string;
}

export interface ChaseRule {
  after: string;
  every: string;
  max: number;
}

export interface Autonomy {
  reply: Level;
  open_pr: Level;
  merge: Level;
  sensitive_change: Level;
  chase_people: Level;
}

export interface XMaloca {
  mode: Mode;
  humans: Human[];
  agents: Record<string, AgentDecl>;
  autonomy: Autonomy;
  chase: { waiting_on_person?: ChaseRule; waiting_on_pr?: ChaseRule };
  escalation: { to: string; only_for: string[] };
  github?: { repos?: string[]; label?: string };
  /** Token lives in secrets (SLACK_TOKEN), never here. `as: human` needs a user token (xoxp-). */
  slack?: { as: "human" | "bot"; channels?: string[] };
  runtime?: { command?: string; model?: string };
  budget?: { daily_usd?: number };
}

export interface Maloca {
  version: string;
  name: string;
  pods: Pod[];
  edges: Edge[];
  "x-maloca": XMaloca;
}

export const ESCALATION_REASONS = [
  "credential",
  "money",
  "personal",
  "product_conflict",
  "irreversible_prod",
] as const;

const LEVELS: Level[] = ["off", "propose", "judge", "auto", "human"];
const ROLES: Role[] = ["gatekeeper", "triage", "investigator", "builder", "deliverer", "chaser", "judge"];

export function parseDuration(s: string): number {
  const m = String(s).trim().match(/^(\d+)\s*(m|h|d)$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

export function loadMaloca(path: string): Maloca {
  if (!existsSync(path)) throw new Error(`no ${path} here. Run \`pororoca init\` first.`);
  const obj = Bun.YAML.parse(readFileSync(path, "utf8")) as Maloca;
  const errors = validateMaloca(obj);
  if (errors.length) throw new Error(`${path} is invalid:\n  - ${errors.join("\n  - ")}`);
  return obj;
}

/** Schema errors. An empty list means the file is usable. */
export function validateMaloca(m: unknown): string[] {
  const e: string[] = [];
  if (!m || typeof m !== "object") return ["file is empty or not a mapping"];
  const o = m as Partial<Maloca>;
  if (String(o.version) !== "0.2") e.push('version must be "0.2" (OpenRig rig spec)');
  if (!o.name) e.push("name is required");
  if (!Array.isArray(o.pods) || o.pods.length === 0) e.push("pods must list at least one pod");
  if (o.edges !== undefined && !Array.isArray(o.edges)) e.push("edges must be a list");
  const x = o["x-maloca"];
  if (!x) return [...e, "x-maloca block is required"];
  if (x.mode !== "solo" && x.mode !== "team") e.push("x-maloca.mode must be solo or team");
  if (!Array.isArray(x.humans) || x.humans.length === 0) e.push("x-maloca.humans needs at least one human");
  if (x.mode === "solo" && (x.humans?.length ?? 0) > 1) e.push("solo mode has exactly one human");
  if (!x.agents || typeof x.agents !== "object") e.push("x-maloca.agents is required");
  for (const [id, a] of Object.entries(x.agents ?? {})) {
    if (!ROLES.includes(a.role)) e.push(`agent ${id}: unknown role ${a.role}`);
    if (a.schedule && !validCron(a.schedule)) e.push(`agent ${id}: invalid cron "${a.schedule}"`);
  }
  for (const [k, v] of Object.entries(x.autonomy ?? {})) {
    if (!LEVELS.includes(v as Level)) e.push(`autonomy.${k}: ${v} is not one of ${LEVELS.join("|")}`);
  }
  for (const [k, r] of Object.entries(x.chase ?? {})) {
    if (!r) continue;
    if (Number.isNaN(parseDuration(r.after)) || Number.isNaN(parseDuration(r.every)))
      e.push(`chase.${k}: after/every must look like 60m, 2h or 1d`);
    if (!(r.max > 0)) e.push(`chase.${k}: max must be a positive number`);
  }
  if (x.escalation) {
    for (const r of x.escalation.only_for ?? [])
      if (!(ESCALATION_REASONS as readonly string[]).includes(r)) e.push(`escalation.only_for: unknown reason ${r}`);
    if (!x.humans?.some((h) => h.id === x.escalation.to)) e.push(`escalation.to: ${x.escalation.to} is not a declared human`);
  } else e.push("x-maloca.escalation is required");
  return e;
}

/**
 * `pororoca maloca check`: structural problems that schema validation can't see.
 * The most important one is the "delivered but still waiting" hole: every waiting
 * kind must have a chaser.
 */
export function checkMaloca(m: Maloca): string[] {
  const p: string[] = [];
  const x = m["x-maloca"];
  const byRole = (r: Role) => Object.entries(x.agents).filter(([, a]) => a.role === r);
  if (byRole("gatekeeper").length !== 1) p.push("exactly one gatekeeper is required: it is the only way into the human lane");
  if (x.autonomy?.sensitive_change === "auto") p.push("sensitive_change can't be auto: CI, migrations, infra and secrets always go to the judge or the human");
  if (byRole("chaser").length === 0) p.push("no chaser: cards waiting on someone would have no owner");
  if (!x.chase?.waiting_on_person) p.push('hole: state "waiting on a person" has no chase rule');
  if (!x.chase?.waiting_on_pr) p.push('hole: state "waiting on a PR" has no chase rule');
  for (const r of ["triage", "investigator", "builder", "deliverer"] as Role[])
    if (byRole(r).length === 0) p.push(`no ${r}: the pipeline has a gap`);

  const memberIds = new Set(m.pods.flatMap((pod) => pod.members.map((mm) => mm.id)));
  for (const id of Object.keys(x.agents)) if (!memberIds.has(id)) p.push(`agent ${id} is declared in x-maloca but not a member of any pod`);
  for (const id of memberIds) if (!x.agents[id]) p.push(`pod member ${id} has no x-maloca.agents entry`);

  const gk = new Set(byRole("gatekeeper").map(([id]) => id));
  const humans = new Set(x.humans.map((h) => h.id));
  for (const edge of m.edges ?? [])
    if ((humans.has(edge.to) || edge.to === "you") && !gk.has(edge.from))
      p.push(`edge ${edge.from} -> ${edge.to} reaches the human without the gatekeeper`);
  return p;
}

/** Plain OpenRig rig spec: OpenRig rejects unknown keys, so x-* goes away. */
export function exportOpenRig(m: Maloca): string {
  const strip = <T extends Record<string, unknown>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("x-")));
  const rig = {
    version: m.version,
    name: m.name,
    pods: m.pods.map((pod) => ({ ...strip(pod), members: pod.members.map((mm) => strip(mm)) })),
    edges: (m.edges ?? []).map((e) => strip(e)),
  };
  return quoteVersion(Bun.YAML.stringify(rig, null, 2) + "\n");
}

// ---------- presets ----------

export type Preset = "solo-dev" | "tech-lead" | "founder";
export const PRESETS: Record<Preset, string> = {
  "solo-dev": "GitHub only. The fleet works issues labelled `pororoca` and replies on the issue.",
  "tech-lead": "GitHub plus a chat adapter, chasing on. For someone everything lands on.",
  founder: "Chat first, building off. Triage, answer and chase; code goes to the team.",
};

export const STARTER_AGENTS: Record<string, AgentDecl> = {
  gatekeeper: { name: "Guaraná", role: "gatekeeper" },
  triage: { name: "Curupira", role: "triage", schedule: "*/5 * * * *" },
  investigator: { name: "Boto", role: "investigator" },
  builder: { name: "Boitatá", role: "builder" },
  deliverer: { name: "Uirapuru", role: "deliverer" },
  chaser: { name: "Iara", role: "chaser", schedule: "*/10 * * * *" },
};

export function presetMaloca(preset: Preset, human: Human, repos: string[] = [], name = "my-fleet"): Maloca {
  const agents = structuredClone(STARTER_AGENTS);
  const autonomy: Autonomy = {
    reply: "propose",
    open_pr: "auto",
    merge: "judge",
    sensitive_change: "human",
    chase_people: "off",
  };
  if (preset === "tech-lead") autonomy.chase_people = "propose";
  if (preset === "founder") {
    autonomy.open_pr = "off";
    autonomy.merge = "off";
  }
  return {
    version: "0.2",
    name,
    pods: [
      {
        id: "core",
        members: Object.keys(agents).map((id) => ({ id, runtime: "claude-code" })),
      },
    ],
    edges: [
      { from: "triage", to: "gatekeeper" },
      { from: "gatekeeper", to: human.id, kind: "escalate" },
      { from: "gatekeeper", to: "investigator" },
      { from: "investigator", to: "builder" },
      { from: "builder", to: "deliverer" },
      { from: "deliverer", to: "chaser" },
    ],
    "x-maloca": {
      mode: "solo",
      humans: [human],
      agents,
      autonomy,
      chase: {
        waiting_on_person: { after: "60m", every: "30m", max: 4 },
        waiting_on_pr: { after: "2h", every: "2h", max: 3 },
      },
      escalation: { to: human.id, only_for: [...ESCALATION_REASONS] },
      github: { repos, label: "pororoca" },
    },
  };
}

/** Bun's YAML writer leaves "0.2" unquoted, which reads back as a number. */
const quoteVersion = (y: string) => y.replace(/[ \t]+$/gm, "").replace(/^version: 0\.2$/m, 'version: "0.2"');

export function malocaToYaml(m: Maloca): string {
  return quoteVersion(
    "# maloca.yaml: your fleet, declared. OpenRig rig spec v0.2 underneath; Pororoca fields live under x-maloca.\n" +
    "# Docs: https://cavalcanticampos.github.io/pororoca/spec/maloca.html\n" +
    Bun.YAML.stringify(m, null, 2) +
    "\n",
  );
}

export function agentName(m: Maloca, role: Role): string {
  const e = Object.entries(m["x-maloca"].agents).find(([, a]) => a.role === role);
  return e ? (e[1].name ?? e[0]) : role;
}
