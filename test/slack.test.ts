import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanAnsweredError, SlackApi, SlackConversation, slackManifest, type KV } from "../src/adapters/slack.ts";
import { connectSlack } from "../src/connect.ts";
import { Fleet } from "../src/fleet.ts";
import { loadMaloca, malocaToYaml, presetMaloca } from "../src/maloca.ts";
import { FakeRuntime } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import type { Card } from "../src/types.ts";

// A tiny fake of the Slack Web API.
const slack = {
  history: {} as Record<string, any[]>,
  replies: [] as any[],
  search: [] as any[],
  posted: [] as Record<string, string>[],
  calls: [] as string[],
};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.replace("/api/", "");
    const p = Object.fromEntries(new URLSearchParams(await req.text()));
    slack.calls.push(method);
    const ok = (o: object) => Response.json({ ok: true, ...o });
    if (req.headers.get("authorization") !== "Bearer xoxp-good") return Response.json({ ok: false, error: "invalid_auth" });
    switch (method) {
      case "auth.test":
        return ok({ user_id: "UME", user: "me", team: "acme" });
      case "users.conversations":
        return ok({ channels: [{ id: "D1", is_im: true }] });
      case "conversations.history":
        return ok({ messages: (slack.history[p.channel!] ?? []).filter((m) => Number(m.ts) > Number(p.oldest ?? 0)) });
      case "conversations.replies":
        return ok({ messages: slack.replies });
      case "search.messages":
        return ok({ messages: { matches: slack.search } });
      case "chat.postMessage":
        slack.posted.push(p);
        return ok({ ts: "999.0" });
    }
    return Response.json({ ok: false, error: "unknown_method" });
  },
});
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const api = (token = "xoxp-good") => new SlackApi(token, base);

function kv(): KV {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => (v === null ? m.delete(k) : m.set(k, v)) };
}

const t0 = new Date("2026-11-18T12:00:00Z");
const sec = (d: Date, plus = 0) => (d.getTime() / 1000 + plus).toFixed(6);

describe("Slack inbound", () => {
  test("only messages after the first fetch, from other people, become cards", async () => {
    slack.history = { D1: [{ ts: sec(t0, -60), user: "U2", text: "old" }] };
    slack.search = [];
    const s = new SlackConversation({ token: "xoxp-good", as: "human", state: kv(), api: api(), now: () => t0 });
    expect(await s.fetch()).toEqual([]);
    slack.history.D1!.push(
      { ts: sec(t0, 10), user: "U2", text: "can you check the deploy?\nthanks" },
      { ts: sec(t0, 11), user: "UME", text: "mine" },
      { ts: sec(t0, 12), bot_id: "B1", text: "bot" },
      { ts: sec(t0, 13), user: "U2", subtype: "channel_join", text: "joined" },
    );
    const items = await s.fetch();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ext_id: `D1:${sec(t0, 10)}`, title: "can you check the deploy?" });
    expect(await s.fetch()).toEqual([]); // cursor moved
  });

  test("mentions anywhere come from search (user token)", async () => {
    slack.history = { D1: [] };
    slack.search = [];
    const state = kv();
    const s = new SlackConversation({ token: "xoxp-good", as: "human", state, api: api(), now: () => t0 });
    await s.fetch();
    slack.search = [{ ts: sec(t0, 30), user: "U3", text: "<@UME> review this?", channel: { id: "C9" }, thread_ts: sec(t0, 20) }];
    const items = await s.fetch();
    expect(items.map((i) => i.ext_id)).toEqual([`C9:${sec(t0, 20)}/${sec(t0, 30)}`]);
    expect(items[0]!.title).toBe("@… review this?");
  });
});

describe("Slack replies", () => {
  const card = (ext: string) => ({ id: 1, ext_id: ext }) as Card;

  test("replies in the thread with the 🤖 signature", async () => {
    slack.posted = [];
    slack.replies = [];
    const s = new SlackConversation({ token: "xoxp-good", as: "human", state: kv(), api: api() });
    await s.reply(card("C9:100.0/101.0"), "on it");
    expect(slack.posted[0]).toMatchObject({ channel: "C9", thread_ts: "100.0" });
    expect(slack.posted[0]!.text).toContain("🤖");
  });

  test("stays quiet when you already answered", async () => {
    slack.posted = [];
    slack.replies = [{ ts: "102.0", user: "UME", text: "done already" }];
    const s = new SlackConversation({ token: "xoxp-good", as: "human", state: kv(), api: api() });
    expect(s.reply(card("C9:100.0/101.0"), "on it")).rejects.toBeInstanceOf(HumanAnsweredError);
    expect(slack.posted).toHaveLength(0);
  });

  test("the fleet closes the card as 'you answered first'", async () => {
    slack.posted = [];
    slack.history = { D1: [{ ts: "201.0", user: "UME", text: "never mind, sorted" }] };
    const dir = mkdtempSync(join(tmpdir(), "pororoca-slack-"));
    const store = new Store(dir);
    const maloca = presetMaloca("solo-dev", { id: "me" });
    maloca["x-maloca"].autonomy.reply = "auto";
    const j = JSON.stringify;
    const fleet = new Fleet({
      maloca,
      store,
      stateDir: dir,
      runtime: new FakeRuntime((r) =>
        r.role === "triage" ? j({ kind: "question", summary: "s" }) : r.role === "gatekeeper" ? j({ needs_human: false, why: "ok" }) : j({ action: "reply", reply: "here" }),
      ),
      conversations: { slack: new SlackConversation({ token: "xoxp-good", as: "human", state: kv(), api: api() }) },
    });
    const c = store.add({ source: "slack", ext_id: "D1:200.0", title: "q" })!;
    await fleet.drain();
    expect(store.get(c.id)!.state).toBe("done");
    expect(store.get(c.id)!.reason).toBe("you answered first");
    expect(slack.posted).toHaveLength(0);
  });
});

describe("connect slack", () => {
  function fleetDir() {
    const dir = mkdtempSync(join(tmpdir(), "pororoca-connect-"));
    writeFileSync(join(dir, "maloca.yaml"), malocaToYaml(presetMaloca("solo-dev", { id: "me" })));
    return { dir, malocaPath: join(dir, "maloca.yaml"), stateDir: join(dir, ".pororoca") };
  }

  test("tests the token, saves it with mode 600, and adds slack to the maloca", async () => {
    const f = fleetDir();
    const r = await connectSlack({ malocaPath: f.malocaPath, stateDir: f.stateDir, token: "xoxp-good", api: api() });
    expect(r.ok).toBe(true);
    expect(loadMaloca(f.malocaPath)["x-maloca"].slack).toEqual({ as: "human" });
    expect(readFileSync(f.malocaPath, "utf8")).not.toContain("xoxp");
    expect(statSync(join(f.stateDir, "secrets.env")).mode & 0o777).toBe(0o600);
  });

  test("refuses bad tokens without saving", async () => {
    const f = fleetDir();
    expect((await connectSlack({ malocaPath: f.malocaPath, stateDir: f.stateDir, token: "abc" })).ok).toBe(false);
    expect((await connectSlack({ malocaPath: f.malocaPath, stateDir: f.stateDir, token: "xoxb-1", as: "human" })).ok).toBe(false);
    const r = await connectSlack({ malocaPath: f.malocaPath, stateDir: f.stateDir, token: "xoxp-bad", api: api("xoxp-bad") });
    expect(r.lines[0]).toContain("invalid_auth");
    expect(loadMaloca(f.malocaPath)["x-maloca"].slack).toBeUndefined();
  });

  test("manifest lists the scopes", () => {
    const m = Bun.YAML.parse(slackManifest()) as any;
    expect(m.oauth_config.scopes.user).toContain("search:read");
    expect(m.oauth_config.scopes.user).toContain("chat:write");
  });
});
