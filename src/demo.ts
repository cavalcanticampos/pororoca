// `pororoca demo`: a whole fleet against a fake inbox. No GitHub, no Slack, no Claude account.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalInbox } from "./adapters/inbox.ts";
import type { BuildResult, Forge } from "./adapters/types.ts";
import { Fleet, humanLane } from "./fleet.ts";
import { presetMaloca } from "./maloca.ts";
import { formatMetrics, metrics } from "./metrics.ts";
import { FakeRuntime, type RunRequest } from "./runtime.ts";
import { Store } from "./store.ts";
import type { Card } from "./types.ts";

export const DEMO_INBOX = [
  {
    title: "The signup page returns 500 when the email has a plus sign",
    body: "Users with addresses like ana+news@example.com can't sign up since yesterday.",
    repo: "acme/web",
  },
  {
    title: "When is Friday's deploy window?",
    body: "I need to tell the client when the new reports go live.",
    repo: null,
  },
  {
    title: "Can we renew the error-tracking vendor? $12k per year",
    body: "The contract expires next week; they want a signature by Monday.",
    repo: null,
  },
];

const json = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

function demoScript(req: RunRequest): string {
  const p = req.prompt;
  const is = (s: string) => p.includes(s);
  switch (req.role) {
    case "triage":
      if (is("500")) return json({ kind: "bug", repo: "acme/web", summary: "signup fails for emails with +" });
      if (is("deploy window")) return json({ kind: "question", repo: null, summary: "asks for Friday's deploy window" });
      return json({ kind: "request", repo: null, summary: "vendor renewal, $12k/year" });
    case "gatekeeper":
      if (is("$12k")) return json({ needs_human: true, reason: "money", why: "spending $12k needs your signature" });
      return json({ needs_human: false, reason: null, why: is("500") ? "a bug the fleet can fix" : "the answer is in the release calendar" });
    case "investigator":
      if (is("500"))
        return json({ action: "build", plan: "The email validator rejects '+'. Fix the regex in src/validate.ts and add a test." });
      return json({ action: "reply", reply: "Friday's window is 14:00 to 15:00 UTC. The new reports are in that release." });
    default:
      return json({});
  }
}

class DemoForge implements Forge {
  readonly id = "demo";
  private merged = new Set<string>();
  async build(card: Card): Promise<BuildResult> {
    const prUrl = `https://github.com/acme/web/pull/${100 + card.id}`;
    this.merged.add(prUrl);
    return { ok: true, prUrl, files: ["src/validate.ts", "test/validate.test.ts"], costUsd: 0 };
  }
  async inFlight(): Promise<string[]> {
    return [];
  }
  async prState(url: string) {
    return this.merged.has(url) ? ("merged" as const) : ("open" as const);
  }
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  teal: (s: string) => `\x1b[36m${s}\x1b[0m`,
  coral: (s: string) => `\x1b[38;5;209m${s}\x1b[0m`,
};

export async function runDemo(o: { fast?: boolean; write?: (s: string) => void } = {}): Promise<{ resolvedWithoutYou: number | null; lane: number }> {
  const write = o.write ?? ((s: string) => console.log(s));
  const pause = (ms: number) => (o.fast ? Promise.resolve() : Bun.sleep(ms));
  const dir = mkdtempSync(join(tmpdir(), "pororoca-demo-"));
  try {
    const store = new Store(dir);
    const maloca = presetMaloca("tech-lead", { id: "you", name: "You" }, ["acme/web"], "demo-fleet");
    maloca["x-maloca"].shadow = { enabled: false };
    maloca["x-maloca"].autonomy.reply = "auto";
    const fleet = new Fleet({
      maloca,
      store,
      runtime: new FakeRuntime(demoScript),
      stateDir: dir,
      conversations: { inbox: new LocalInbox() },
      forge: new DemoForge(),
      log: (line) => write(`  ${line.includes("needs you") || line.includes("Sent to you") ? c.coral(line) : line}`),
    });

    write(c.bold("\n🌊 Pororoca demo: a fleet working a fake inbox\n"));
    write(c.dim("   Six agents: Guaraná (gatekeeper), Curupira (triage), Boto (investigator),"));
    write(c.dim("   Boitatá (builder), Uirapuru (deliverer), Iara (chaser). Runtime: scripted.\n"));
    await pause(700);
    for (const item of DEMO_INBOX) {
      const card = store.add({ source: "inbox", title: item.title, body: item.body, repo: item.repo })!;
      write(`  ${c.teal(`📥 #${card.id}`)} ${card.title}`);
      await pause(350);
    }
    write("");
    for (let i = 0; i < 8; i++) {
      const before = store.list().map((x) => x.state).join();
      await fleet.tick({ fetch: false, chase: false });
      await pause(500);
      if (store.list().map((x) => x.state).join() === before) break;
    }
    // time passes; the chaser looks at the PR
    await fleet.chase();
    write("");
    for (const s of store.events().filter((e) => e.kind === "sent")) {
      write(`  ${c.teal("🤖 sent")} on #${s.card_id}: ${s.detail!.split("\n")[0]}`);
      await pause(250);
    }
    const lane = humanLane(store);
    write(c.bold(`\n  Your lane: ${lane.length} card${lane.length === 1 ? "" : "s"}`));
    for (const card of lane) write(`  ${c.coral(`👤 #${card.id}`)} ${card.title}  ${c.dim(`(${card.reason})`)}`);
    const m = metrics(store, 7, false);
    write("\n" + formatMetrics(m).replace(/^/gm, "  "));
    write(c.dim("\n  A real fleet starts in shadow mode: it proposes and sends nothing until you switch each autonomy level on."));
    write(`  Next: ${c.bold("pororoca doctor")}, then ${c.bold("pororoca init")}.\n`);
    store.close();
    return { resolvedWithoutYou: m.resolvedWithoutYou, lane: lane.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
