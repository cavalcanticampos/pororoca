import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubForge, GitHubIssues } from "../src/adapters/github.ts";
import type { Exec } from "../src/adapters/types.ts";
import { doctor, watchers } from "../src/doctor.ts";
import { malocaToYaml, presetMaloca } from "../src/maloca.ts";
import { FakeRuntime } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import type { Card } from "../src/types.ts";

function fakeExec(handler: (cmd: string[]) => { code?: number; out?: string; err?: string }): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const f = (async (cmd: string[]) => {
    calls.push(cmd);
    const r = handler(cmd);
    return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? "" };
  }) as Exec & { calls: string[][] };
  f.calls = calls;
  return f;
}

describe("GitHub issues", () => {
  test("fetches labelled issues and comments as the human with the 🤖 signature", async () => {
    const exec = fakeExec((cmd) => (cmd[1] === "issue" && cmd[2] === "list" ? { out: JSON.stringify([{ number: 7, title: "t", body: "b" }]) } : {}));
    const gh = new GitHubIssues(["a/b"], "pororoca", exec);
    const items = await gh.fetch();
    expect(items).toEqual([{ ext_id: "a/b#7", title: "t", body: "b", repo: "a/b" }]);
    await gh.reply({ id: 1, ext_id: "a/b#7" } as Card, "hello");
    const comment = exec.calls.at(-1)!;
    expect(comment.slice(0, 5)).toEqual(["gh", "issue", "comment", "7", "-R"]);
    expect(comment.at(-1)).toContain("🤖");
  });
});

describe("GitHub forge", () => {
  test("worktree, builder session, commit, push, PR", async () => {
    const work = mkdtempSync(join(tmpdir(), "pororoca-forge-"));
    const exec = fakeExec((cmd) => {
      if (cmd[0] === "git" && cmd[1] === "symbolic-ref") return { out: "origin/main\n" };
      if (cmd[0] === "git" && cmd[1] === "diff") return { out: "src/a.ts\n" };
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") return { out: "https://github.com/a/b/pull/3\n" };
      return {};
    });
    const forge = new GitHubForge(work, exec);
    const runtime = new FakeRuntime(() => '{"summary":"fixed"}');
    const r = await forge.build({ id: 5, repo: "a/b", title: "bug", ext_id: "a/b#7" } as Card, "plan", "prompt", runtime, "builder");
    expect(r).toMatchObject({ ok: true, prUrl: "https://github.com/a/b/pull/3", files: ["src/a.ts"] });
    expect(runtime.calls[0]!.allowEdits).toBe(true);
    expect(runtime.calls[0]!.cwd).toContain("card-5");
    const flat = exec.calls.map((c) => c.slice(0, 3).join(" "));
    expect(flat).toContain("git worktree add");
    expect(flat).toContain("git push -q");
  });

  test("builder saying it's already done skips the PR", async () => {
    const exec = fakeExec((cmd) => (cmd[1] === "symbolic-ref" ? { out: "origin/main" } : {}));
    const forge = new GitHubForge(mkdtempSync(join(tmpdir(), "pororoca-forge-")), exec);
    const r = await forge.build({ id: 1, repo: "a/b", title: "x" } as Card, "", "", new FakeRuntime(() => '{"already_done":"#9"}'), "builder");
    expect(r.alreadyDone).toBe("#9");
    expect(exec.calls.some((c) => c[2] === "create")).toBe(false);
  });
});

describe("doctor", () => {
  test("reports each failure with its fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pororoca-doc-"));
    const exec = fakeExec((cmd) => (cmd[0] === "claude" ? { code: 127 } : cmd[0] === "gh" ? { code: 1 } : { out: "git version 2" }));
    const checks = await doctor({ malocaPath: join(dir, "maloca.yaml"), stateDir: join(dir, ".pororoca"), exec });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["Claude Code"]!.ok).toBe(false);
    expect(by["GitHub CLI"]!.fix).toBe("gh auth login");
    expect(by["maloca.yaml"]!.fix).toBe("pororoca init");
    expect(by["state directory"]!.ok).toBe(true);
  });

  test("a valid maloca passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pororoca-doc-"));
    writeFileSync(join(dir, "maloca.yaml"), malocaToYaml(presetMaloca("solo-dev", { id: "me" })));
    const checks = await doctor({ malocaPath: join(dir, "maloca.yaml"), stateDir: join(dir, ".p"), exec: fakeExec(() => ({ out: "ok" })) });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test("watchers turn silent failures into findings", async () => {
    const clock = new Date("2026-11-18T12:00:00Z");
    const store = new Store(":memory:", () => clock);
    const c = store.add({ source: "inbox", title: "x" })!;
    store.move(c.id, "repair", "broken");
    store.event(c.id, "cost", "9.5");
    store.setMeta("paused_until", "2026-11-18T13:00:00Z");
    const found = await watchers(store, { stateDir: "/", dailyBudgetUsd: 5, exec: fakeExec(() => ({ out: "h\n/dev 1 1 1 95% /" })) });
    expect(found.join("\n")).toContain("repair queue");
    expect(found.join("\n")).toContain("over the $5 budget");
    expect(found.join("\n")).toContain("disk 95% full");
    expect(found.join("\n")).toContain("paused");
  });
});
