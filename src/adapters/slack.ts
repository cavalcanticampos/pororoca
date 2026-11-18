// Slack through the Web API. With a user token the fleet reads and replies as you (signed 🤖);
// with a bot token it reads and replies as the app.
//
// Inbound: your DMs and group DMs, mentions of you (user token, search:read), and any channel
// listed in x-maloca.slack.channels. Only messages that arrive after the first fetch count.

import type { Card } from "../types.ts";
import type { Conversation, Inbound } from "./types.ts";

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export class HumanAnsweredError extends Error {
  readonly code = "human_answered";
  constructor() {
    super("you already answered in this conversation");
  }
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  channel?: { id: string } | string;
}

export class SlackApi {
  constructor(
    private token: string,
    private base = process.env.SLACK_API_BASE ?? "https://slack.com",
  ) {}

  async call<T = Record<string, unknown>>(method: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (r.status === 429) {
        await Bun.sleep(Math.min(Number(r.headers.get("retry-after") ?? 1), 30) * 1000);
        continue;
      }
      const j = (await r.json()) as { ok: boolean; error?: string } & T;
      if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
      return j;
    }
    throw new Error(`slack ${method}: rate limited`);
  }
}

export interface SlackOptions {
  token: string;
  as: "human" | "bot";
  channels?: string[];
  state: KV;
  api?: SlackApi;
  now?: () => Date;
}

export class SlackConversation implements Conversation {
  readonly id = "slack";
  readonly speaksAsHuman: boolean;
  private api: SlackApi;
  private me: string | null = null;

  constructor(private o: SlackOptions) {
    this.speaksAsHuman = o.as === "human";
    this.api = o.api ?? new SlackApi(o.token);
  }

  async whoami(): Promise<{ user_id: string; user: string; team: string }> {
    const r = await this.api.call<{ user_id: string; user: string; team: string }>("auth.test");
    this.me = r.user_id;
    return r;
  }

  private cursorKey(ch: string) {
    return `slack_cursor:${ch}`;
  }

  /** First sight of a conversation sets its cursor to now: only new messages become cards. */
  private cursor(ch: string): string | null {
    const c = this.o.state.get(this.cursorKey(ch));
    if (c === null) {
      const now = ((this.o.now?.() ?? new Date()).getTime() / 1000).toFixed(6);
      this.o.state.set(this.cursorKey(ch), now);
      return null;
    }
    return c;
  }

  private fromSomeoneElse(m: SlackMessage): boolean {
    return !!m.user && m.user !== this.me && !m.bot_id && (!m.subtype || m.subtype === "thread_broadcast");
  }

  private toInbound(ch: string, m: SlackMessage, where: string): Inbound {
    const text = (m.text ?? "").trim();
    const first = text.split("\n")[0]!.replace(/<@\w+>/g, "@…").slice(0, 100) || "(no text)";
    return {
      ext_id: `${ch}:${m.thread_ts && m.thread_ts !== m.ts ? `${m.thread_ts}/` : ""}${m.ts}`,
      title: first,
      body: `${text}\n\n(from <@${m.user}> in ${where})`,
    };
  }

  async fetch(): Promise<Inbound[]> {
    if (!this.me) await this.whoami();
    const out: Inbound[] = [];

    const ims = await this.api.call<{ channels: { id: string; is_im?: boolean }[] }>("users.conversations", {
      types: "im,mpim",
      exclude_archived: "true",
      limit: 200,
    });
    const watched = [...ims.channels.map((c) => ({ id: c.id, where: c.is_im ? "a DM" : "a group DM" })), ...(this.o.channels ?? []).map((id) => ({ id, where: `<#${id}>` }))];

    for (const { id, where } of watched) {
      const oldest = this.cursor(id);
      if (oldest === null) continue;
      const h = await this.api.call<{ messages: SlackMessage[] }>("conversations.history", { channel: id, oldest, limit: 100 });
      const msgs = h.messages.filter((m) => this.fromSomeoneElse(m)).sort((a, b) => Number(a.ts) - Number(b.ts));
      // in watched channels only messages that mention you count; DMs are always for you
      for (const m of msgs) if (where.startsWith("a ") || (m.text ?? "").includes(`<@${this.me}>`)) out.push(this.toInbound(id, m, where));
      const newest = h.messages.reduce((mx, m) => (Number(m.ts) > Number(mx) ? m.ts : mx), oldest);
      this.o.state.set(this.cursorKey(id), newest);
    }

    if (this.o.as === "human") {
      const since = this.cursor("search");
      if (since !== null) {
        try {
          const s = await this.api.call<{ messages: { matches: (SlackMessage & { channel: { id: string; is_im?: boolean } })[] } }>("search.messages", {
            query: `<@${this.me}>`,
            sort: "timestamp",
            count: 50,
          });
          let newest = since;
          for (const m of s.messages.matches) {
            if (Number(m.ts) <= Number(since)) continue;
            if (Number(m.ts) > Number(newest)) newest = m.ts;
            const ch = typeof m.channel === "string" ? m.channel : m.channel.id;
            if (watched.some((w) => w.id === ch) || !this.fromSomeoneElse(m)) continue;
            out.push(this.toInbound(ch, m, `<#${ch}>`));
          }
          this.o.state.set(this.cursorKey("search"), newest);
        } catch (e) {
          if (!/missing_scope|not_allowed_token_type/.test((e as Error).message)) throw e;
        }
      }
    }
    return out;
  }

  private parse(card: Card): { channel: string; thread: string | null; ts: string } {
    const m = card.ext_id?.match(/^([^:]+):(?:([\d.]+)\/)?([\d.]+)$/);
    if (!m) throw new Error(`card #${card.id} is not a Slack message`);
    return { channel: m[1]!, thread: m[2] ?? null, ts: m[3]! };
  }

  /**
   * Replies in the thread (DMs: in the conversation). Pattern "human takeover": if you already
   * answered after the message, the fleet does not speak over you.
   */
  async reply(card: Card, text: string): Promise<void> {
    if (!this.me) await this.whoami();
    const { channel, thread, ts } = this.parse(card);
    const root = thread ?? ts;
    const isDm = channel.startsWith("D");
    const later = isDm && !thread
      ? (await this.api.call<{ messages: SlackMessage[] }>("conversations.history", { channel, oldest: ts, limit: 50 })).messages
      : (await this.api.call<{ messages: SlackMessage[] }>("conversations.replies", { channel, ts: root, oldest: ts, limit: 50 })).messages;
    if (later.some((m) => m.user === this.me && Number(m.ts) > Number(ts) && !(m.text ?? "").includes("🤖"))) throw new HumanAnsweredError();
    await this.api.call("chat.postMessage", {
      channel,
      text: `${text}\n\n🤖 sent by my Pororoca fleet`,
      thread_ts: isDm && !thread ? undefined : root,
      unfurl_links: "false",
    });
  }
}

/** Scopes for the Slack app. User scopes make the fleet act as you; bot scopes as the app. */
export const SLACK_USER_SCOPES = ["im:history", "im:read", "mpim:history", "mpim:read", "channels:history", "groups:history", "search:read", "chat:write", "users:read"];
export const SLACK_BOT_SCOPES = ["im:history", "im:read", "mpim:history", "mpim:read", "channels:history", "groups:history", "chat:write", "users:read", "app_mentions:read"];

export function slackManifest(name = "Pororoca"): string {
  return `display_information:
  name: ${name}
  description: A fleet of agents that works for you
features:
  bot_user:
    display_name: ${name.toLowerCase()}
    always_online: false
oauth_config:
  scopes:
    user:
${SLACK_USER_SCOPES.map((s) => `      - ${s}`).join("\n")}
    bot:
${SLACK_BOT_SCOPES.map((s) => `      - ${s}`).join("\n")}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}
