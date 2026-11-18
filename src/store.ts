// The card store: one SQLite file in the state directory.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Card, CardEvent, CardState } from "./types.ts";

export type Clock = () => Date;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ext_id TEXT,
  repo TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  kind TEXT,
  reason TEXT,
  draft TEXT,
  waiting_on TEXT,
  waiting_kind TEXT,
  pr_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  chases INTEGER NOT NULL DEFAULT 0,
  last_chase TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  shadow INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, ext_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_card ON events(card_id);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  area TEXT,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  until TEXT NOT NULL
);
`;

const PATCHABLE = new Set([
  "repo", "title", "body", "state", "kind", "reason", "draft", "waiting_on", "waiting_kind",
  "pr_url", "attempts", "chases", "last_chase", "escalated", "shadow",
]);

export interface Claim {
  id: number;
  repo: string;
  area: string | null;
  owner: string;
  reason: string;
  until: string;
}

export class Store {
  readonly db: Database;
  constructor(readonly dir: string, readonly now: Clock = () => new Date()) {
    if (dir !== ":memory:") mkdirSync(dir, { recursive: true });
    this.db = new Database(dir === ":memory:" ? ":memory:" : join(dir, "pororoca.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  add(c: { source: string; title: string; body?: string; ext_id?: string | null; repo?: string | null }): Card | null {
    const at = this.ts();
    // check first: INSERT OR IGNORE still burns AUTOINCREMENT ids, which leaves gaps in card numbers
    if (c.ext_id && this.db.query("SELECT 1 FROM cards WHERE source = ? AND ext_id = ?").get(c.source, c.ext_id)) return null;
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO cards (source, ext_id, repo, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(c.source, c.ext_id ?? null, c.repo ?? null, c.title, c.body ?? "", at, at) as { id: number } | null;
    if (!r) return null;
    this.event(r.id, "created", c.source);
    return this.get(r.id);
  }

  get(id: number): Card | null {
    return (this.db.query("SELECT * FROM cards WHERE id = ?").get(id) as Card | null) ?? null;
  }

  list(states?: CardState[]): Card[] {
    if (!states) return this.db.query("SELECT * FROM cards ORDER BY id").all() as Card[];
    const q = states.map(() => "?").join(",");
    return this.db.query(`SELECT * FROM cards WHERE state IN (${q}) ORDER BY id`).all(...states) as Card[];
  }

  patch(id: number, fields: Partial<Card>): void {
    const keys = Object.keys(fields).filter((k) => PATCHABLE.has(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => (fields as Record<string, unknown>)[k] as string | number | null);
    this.db.query(`UPDATE cards SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, this.ts(), id);
  }

  move(id: number, state: CardState, reason?: string | null, extra: Partial<Card> = {}): void {
    this.patch(id, { ...extra, state, reason: reason ?? null });
    this.event(id, `state:${state}`, reason ?? null);
  }

  event(cardId: number, kind: string, detail: string | null = null): void {
    this.db.query("INSERT INTO events (card_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(cardId, this.ts(), kind, detail);
  }

  events(cardId?: number): CardEvent[] {
    if (cardId === undefined) return this.db.query("SELECT * FROM events ORDER BY id").all() as CardEvent[];
    return this.db.query("SELECT * FROM events WHERE card_id = ? ORDER BY id").all(cardId) as CardEvent[];
  }

  getMeta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.query("DELETE FROM meta WHERE key = ?").run(key);
    else this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  addClaim(c: { repo: string; area?: string | null; owner: string; reason: string; hours: number }): number {
    const until = new Date(this.now().getTime() + c.hours * 3_600_000).toISOString();
    const r = this.db
      .query("INSERT INTO claims (repo, area, owner, reason, until) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(c.repo, c.area ?? null, c.owner, c.reason, until) as { id: number };
    return r.id;
  }

  removeClaim(id: number): void {
    this.db.query("DELETE FROM claims WHERE id = ?").run(id);
  }

  claims(repo?: string): Claim[] {
    const at = this.ts();
    if (repo) return this.db.query("SELECT * FROM claims WHERE repo = ? AND until > ? ORDER BY id").all(repo, at) as Claim[];
    return this.db.query("SELECT * FROM claims WHERE until > ? ORDER BY id").all(at) as Claim[];
  }

  close(): void {
    this.db.close();
  }
}
