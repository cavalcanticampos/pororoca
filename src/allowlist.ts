// The runtime's tool allowlist lives in a file the fleet can edit (pattern from the reference fleet):
// the fleet grants itself a tool the human already asked for, and every grant goes through the judge.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./types.ts";

export type Allowlist = Partial<Record<Role | "all", string[]>>;

export const DEFAULT_ALLOWLIST: Allowlist = {
  all: ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)"],
  builder: [
    "Edit",
    "Write",
    "Bash(bun test:*)",
    "Bash(bun install:*)",
    "Bash(npm test:*)",
    "Bash(npm ci:*)",
    "Bash(pnpm test:*)",
    "Bash(pytest:*)",
    "Bash(go test:*)",
    "Bash(cargo test:*)",
  ],
};

const path = (stateDir: string) => join(stateDir, "allowlist.json");

export function readAllowlist(stateDir: string): Allowlist {
  const f = path(stateDir);
  if (!existsSync(f)) return structuredClone(DEFAULT_ALLOWLIST);
  return JSON.parse(readFileSync(f, "utf8")) as Allowlist;
}

export function toolsFor(stateDir: string, role: Role): string[] {
  const a = readAllowlist(stateDir);
  return [...new Set([...(a.all ?? []), ...(a[role] ?? [])])];
}

/** Tool specs the fleet may never grant itself, judge or not. */
export function forbiddenGrant(tool: string): string | null {
  const t = tool.trim();
  if (!/^[A-Za-z_][\w-]*(\(.+\))?$/.test(t)) return "not a tool spec like Bash(npm run lint:*)";
  if (t === "Bash" || /^Bash\(\s*\*?\s*(:\*)?\)$/.test(t)) return "unrestricted shell";
  if (/\b(sudo|rm -rf|curl|wget|ssh|scp|gh secret|gh auth|aws|kubectl|terraform)\b/.test(t)) return "touches credentials, the network or infrastructure";
  if (/^mcp__/.test(t) && !/^mcp__\w+__\w+$/.test(t)) return "an MCP server as a whole; grant one tool";
  return null;
}

export function grantTool(stateDir: string, role: Role | "all", tool: string): void {
  const a = readAllowlist(stateDir);
  a[role] = [...new Set([...(a[role] ?? []), tool.trim()])];
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path(stateDir), JSON.stringify(a, null, 2) + "\n");
}
