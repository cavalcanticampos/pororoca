// Agent runtime port. v0.1 ships Claude Code; tests and the demo use a scripted fake.

import type { Role } from "./types.ts";

export interface RunRequest {
  agent: string;
  role: Role;
  prompt: string;
  cwd?: string;
  /** Builder sessions may edit files in their worktree. Everyone else is read-only. */
  allowEdits?: boolean;
  /** Tools the session may use without asking (from the fleet's allowlist file). */
  allowedTools?: string[];
}

export interface RunResult {
  ok: boolean;
  text: string;
  /** The runtime hit a usage limit: the whole fleet pauses (pattern: weekly-limit pause). */
  limit?: boolean;
  error?: string;
  costUsd?: number;
}

export interface Runtime {
  readonly name: string;
  run(req: RunRequest): Promise<RunResult>;
}

const LIMIT_RE = /(usage|weekly|session|rate)[ -]limit|hit your .{0,20}limit|limit (reached|exceeded)/i;

export function looksLikeLimit(text: string): boolean {
  return LIMIT_RE.test(text);
}

/** Each agent is an autonomous Claude Code session, launched with `claude -p`. */
export class ClaudeCodeRuntime implements Runtime {
  readonly name = "claude-code";
  constructor(
    private command = "claude",
    private model?: string,
    private timeoutMs = 20 * 60_000,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const args = [this.command, "-p", req.prompt, "--output-format", "json"];
    if (this.model) args.push("--model", this.model);
    args.push("--permission-mode", req.allowEdits ? "acceptEdits" : "default");
    if (req.allowedTools?.length) args.push("--allowedTools", req.allowedTools.join(","));
    let proc;
    try {
      proc = Bun.spawn(args, { cwd: req.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (e) {
      return { ok: false, text: "", error: `could not start ${this.command}: ${(e as Error).message}` };
    }
    const timer = setTimeout(() => proc.kill(), this.timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number } = {};
    try {
      parsed = JSON.parse(out);
    } catch {
      /* non-JSON output: treat as text */
    }
    const text = parsed.result ?? out;
    const limit = looksLikeLimit(text) || looksLikeLimit(err);
    if (code !== 0 || parsed.is_error)
      return { ok: false, text, limit, error: (err || text).slice(0, 500), costUsd: parsed.total_cost_usd };
    return { ok: true, text, limit, costUsd: parsed.total_cost_usd };
  }
}

export type Script = (req: RunRequest) => RunResult | string | Promise<RunResult | string>;

/** A runtime that answers from a script. Used by `pororoca demo` and the tests. */
export class FakeRuntime implements Runtime {
  readonly name = "fake";
  readonly calls: RunRequest[] = [];
  constructor(private script: Script) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    const r = await this.script(req);
    return typeof r === "string" ? { ok: true, text: r, costUsd: 0 } : r;
  }
}
