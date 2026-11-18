// Port interfaces. See docs/spec/adapters.html.

import type { Runtime } from "../runtime.ts";
import type { Card } from "../types.ts";

export interface Inbound {
  ext_id: string;
  title: string;
  body: string;
  repo?: string | null;
}

/** Conversation port: where work arrives and where replies go. */
export interface Conversation {
  readonly id: string;
  /** Replies go out as the human (signed 🤖) rather than as a bot. */
  readonly speaksAsHuman: boolean;
  fetch(): Promise<Inbound[]>;
  reply(card: Card, text: string): Promise<void>;
}

export interface BuildResult {
  ok: boolean;
  prUrl?: string;
  files?: string[];
  /** New content of changed migration files, so the judge can tell additive from destructive. */
  contents?: Record<string, string>;
  alreadyDone?: string;
  notCode?: string;
  error?: string;
  limit?: boolean;
  costUsd?: number;
}

/** Code forge port: turns a plan into a PR. */
export interface Forge {
  readonly id: string;
  build(card: Card, plan: string, prompt: string, runtime: Runtime, agent: string, allowedTools?: string[]): Promise<BuildResult>;
  /** Open and recently merged PRs that touch the repo, for work claims. */
  inFlight(repo: string): Promise<string[]>;
  prState?(url: string): Promise<"open" | "merged" | "closed" | null>;
  /** CI on the PR: `none` when the repo reports no checks. */
  checks?(url: string): Promise<"pass" | "fail" | "pending" | "none">;
  merge?(url: string): Promise<{ ok: boolean; error?: string }>;
  /** The PR's diff as text, for the judge. */
  diff?(url: string): Promise<string>;
  /** A read-only, up-to-date checkout of the repo's default branch, for the investigator. */
  checkout?(repo: string): Promise<string>;
}

export type Exec = (cmd: string[], opts?: { cwd?: string }) => Promise<{ code: number; out: string; err: string }>;

export const realExec: Exec = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

export const SIGNATURE = "\n\n🤖 sent by my Pororoca fleet";
