// Per-repo decision memory: the human shouldn't answer the same question twice.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = (dir: string, repo: string) => join(dir, "decisions", `${repo.replace(/[^\w.-]+/g, "__")}.md`);

export function readDecisions(stateDir: string, repo: string | null): string {
  if (!repo) return "";
  const f = file(stateDir, repo);
  return existsSync(f) ? readFileSync(f, "utf8").slice(-6000) : "";
}

export function recordDecision(stateDir: string, repo: string | null, text: string, at = new Date()): void {
  const f = file(stateDir, repo ?? "_general");
  mkdirSync(join(stateDir, "decisions"), { recursive: true });
  appendFileSync(f, `- ${at.toISOString().slice(0, 10)}: ${text.replace(/\s+/g, " ").trim()}\n`);
}
