// GitHub through the `gh` CLI: issues are the inbox and the tracker, PRs are the forge.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseVerdict, type BuildVerdict } from "../agents.ts";
import type { Runtime } from "../runtime.ts";
import type { Card } from "../types.ts";
import { SIGNATURE, realExec, type BuildResult, type Conversation, type Exec, type Forge, type Inbound } from "./types.ts";

export class GitHubIssues implements Conversation {
  readonly id = "github";
  readonly speaksAsHuman = true;
  constructor(
    private repos: string[],
    private label = "pororoca",
    private exec: Exec = realExec,
  ) {}

  async fetch(): Promise<Inbound[]> {
    const out: Inbound[] = [];
    for (const repo of this.repos) {
      const r = await this.exec([
        "gh", "issue", "list", "-R", repo, "--label", this.label, "--state", "open",
        "--json", "number,title,body", "--limit", "50",
      ]);
      if (r.code !== 0) throw new Error(`gh issue list ${repo}: ${r.err.trim()}`);
      for (const i of JSON.parse(r.out || "[]") as { number: number; title: string; body: string }[])
        out.push({ ext_id: `${repo}#${i.number}`, title: i.title, body: i.body ?? "", repo });
    }
    return out;
  }

  async reply(card: Card, text: string): Promise<void> {
    const m = card.ext_id?.match(/^(.+)#(\d+)$/);
    if (!m) throw new Error(`card #${card.id} has no GitHub issue`);
    const r = await this.exec(["gh", "issue", "comment", m[2]!, "-R", m[1]!, "--body", text + SIGNATURE]);
    if (r.code !== 0) throw new Error(`gh issue comment: ${r.err.trim()}`);
  }
}

export class GitHubForge implements Forge {
  readonly id = "github";
  constructor(
    private workDir: string,
    private exec: Exec = realExec,
  ) {}

  private async git(args: string[], cwd: string) {
    const r = await this.exec(["git", ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err.trim()}`);
    return r.out.trim();
  }

  async inFlight(repo: string): Promise<string[]> {
    const r = await this.exec([
      "gh", "pr", "list", "-R", repo, "--state", "open", "--json", "number,title,headRefName", "--limit", "30",
    ]);
    if (r.code !== 0) return [];
    return (JSON.parse(r.out || "[]") as { number: number; title: string; headRefName: string }[]).map(
      (p) => `open PR #${p.number} (${p.headRefName}): ${p.title}`,
    );
  }

  async prState(url: string): Promise<"open" | "merged" | "closed" | null> {
    const r = await this.exec(["gh", "pr", "view", url, "--json", "state"]);
    if (r.code !== 0) return null;
    const st = (JSON.parse(r.out) as { state: string }).state.toLowerCase();
    return st === "merged" || st === "closed" || st === "open" ? st : null;
  }

  async checks(url: string): Promise<"pass" | "fail" | "pending" | "none"> {
    const r = await this.exec(["gh", "pr", "checks", url, "--json", "bucket"]);
    if (/no checks reported/i.test(r.err)) return "none";
    let rows: { bucket: string }[] = [];
    try {
      rows = JSON.parse(r.out || "[]");
    } catch {
      return "pending";
    }
    if (!rows.length) return "none";
    if (rows.some((x) => x.bucket === "fail" || x.bucket === "cancel")) return "fail";
    if (rows.some((x) => x.bucket === "pending")) return "pending";
    return "pass";
  }

  async diff(url: string): Promise<string> {
    const r = await this.exec(["gh", "pr", "diff", url]);
    if (r.code !== 0) return "";
    return r.out.length > 40_000 ? r.out.slice(0, 40_000) + "\n[diff truncated]" : r.out;
  }

  private async mirror(repo: string): Promise<{ mirror: string; base: string }> {
    const mirror = join(this.workDir, "mirrors", repo.replace("/", "__"));
    mkdirSync(join(this.workDir, "mirrors"), { recursive: true });
    if (!existsSync(mirror)) {
      const r = await this.exec(["gh", "repo", "clone", repo, mirror]);
      if (r.code !== 0) throw new Error(`gh repo clone: ${r.err.trim()}`);
    }
    await this.git(["fetch", "--quiet", "origin"], mirror);
    const base = (await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], mirror)).replace("origin/", "");
    return { mirror, base };
  }

  async checkout(repo: string): Promise<string> {
    const { mirror, base } = await this.mirror(repo);
    const dir = join(this.workDir, "read", repo.replace("/", "__"));
    if (!existsSync(dir)) {
      mkdirSync(join(this.workDir, "read"), { recursive: true });
      await this.git(["worktree", "add", "--detach", dir, `origin/${base}`], mirror);
    } else await this.git(["checkout", "-q", "--detach", `origin/${base}`], dir);
    return dir;
  }

  async merge(url: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.exec(["gh", "pr", "merge", url, "--squash", "--delete-branch"]);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.trim() };
  }

  async build(card: Card, _plan: string, prompt: string, runtime: Runtime, agent: string, allowedTools?: string[]): Promise<BuildResult> {
    if (!card.repo) return { ok: false, error: "card has no repo" };
    const wt = join(this.workDir, "worktrees", `card-${card.id}`);
    const branch = `pororoca/card-${card.id}`;
    try {
      const { mirror, base } = await this.mirror(card.repo);
      mkdirSync(join(this.workDir, "worktrees"), { recursive: true });
      // pattern: technical-failure retry realigns the worktree instead of reusing a broken one
      if (existsSync(wt)) {
        await this.exec(["git", "worktree", "remove", "--force", wt], { cwd: mirror });
        rmSync(wt, { recursive: true, force: true });
      }
      await this.exec(["git", "branch", "-D", branch], { cwd: mirror });
      await this.git(["worktree", "add", "-b", branch, wt, `origin/${base}`], mirror);

      const res = await runtime.run({ agent, role: "builder", prompt, cwd: wt, allowEdits: true, allowedTools });
      if (!res.ok) return { ok: false, error: res.error, limit: res.limit, costUsd: res.costUsd };
      const v = parseVerdict<BuildVerdict>(res.text) ?? {};
      if (v.already_done) return { ok: true, alreadyDone: v.already_done, costUsd: res.costUsd };
      if (v.not_code) return { ok: true, notCode: v.not_code, costUsd: res.costUsd };

      await this.git(["add", "-A"], wt);
      const files = (await this.git(["diff", "--cached", "--name-only"], wt)).split("\n").filter(Boolean);
      if (!files.length) return { ok: true, notCode: "the builder made no changes", costUsd: res.costUsd };
      const contents: Record<string, string> = {};
      for (const f of files) if (/migrat/.test(f) && existsSync(join(wt, f))) contents[f] = readFileSync(join(wt, f), "utf8");
      const title = `${card.title}`.slice(0, 72);
      await this.git(["commit", "-q", "-m", `${title}\n\nPororoca card #${card.id}.`], wt);
      // a retry after red CI rebuilds the same branch, so the push replaces it
      await this.git(["push", "-q", "-f", "-u", "origin", branch], wt);
      const body = `${v.summary ?? ""}\n\nCloses ${card.ext_id?.includes("#") ? card.ext_id : ""}\n${SIGNATURE.trim()}`;
      const pr = await this.exec(["gh", "pr", "create", "-R", card.repo, "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: wt });
      let prUrl = pr.out.trim().split("\n").pop();
      if (pr.code !== 0) {
        if (!/already exists/i.test(pr.err)) throw new Error(`gh pr create: ${pr.err.trim()}`);
        const v = await this.exec(["gh", "pr", "view", branch, "-R", card.repo, "--json", "url", "-q", ".url"]);
        prUrl = v.out.trim();
      }
      return { ok: true, prUrl, files, contents, costUsd: res.costUsd };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
