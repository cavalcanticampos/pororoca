// One metric that matters: the share of incoming work resolved without the human.

import type { Store } from "./store.ts";
import { CLOSED_STATES } from "./types.ts";

export interface Metrics {
  days: number;
  arrived: number;
  closed: number;
  closedWithoutYou: number;
  resolvedWithoutYou: number | null;
  neededYou: number;
  sentByFleet: number;
  sentByYou: number;
  /** Drafts the human sent as they were: the evidence for moving a level from propose to auto. */
  approvedUnchanged: number;
  corrections: number;
  repair: number;
  costUsd: number;
  costPerResolved: number | null;
}

const HUMAN_TOUCH = ["state:you", "escalated", "human_sent", "human_decided", "correction", "human_took_over"];

export function metrics(store: Store, days = 7): Metrics {
  const since = new Date(store.now().getTime() - days * 86_400_000).toISOString();
  const count = (sql: string, ...args: (string | number)[]) =>
    (store.db.query(sql).get(...args) as { n: number }).n;
  const q = CLOSED_STATES.map(() => "?").join(",");
  const arrived = count("SELECT COUNT(*) n FROM cards WHERE created_at >= ?", since);
  const closed = count(`SELECT COUNT(*) n FROM cards WHERE state IN (${q}) AND updated_at >= ?`, ...CLOSED_STATES, since);
  const h = HUMAN_TOUCH.map(() => "?").join(",");
  const touchedClosed = count(
    `SELECT COUNT(*) n FROM cards c WHERE c.state IN (${q}) AND c.updated_at >= ?
     AND EXISTS (SELECT 1 FROM events e WHERE e.card_id = c.id AND e.kind IN (${h}))`,
    ...CLOSED_STATES, since, ...HUMAN_TOUCH,
  );
  const neededYou = count(
    `SELECT COUNT(DISTINCT card_id) n FROM events WHERE kind IN (${h}) AND at >= ? AND card_id > 0`,
    ...HUMAN_TOUCH, since,
  );
  const ev = (kind: string) => count("SELECT COUNT(*) n FROM events WHERE kind = ? AND at >= ?", kind, since);
  const sent = ev("sent");
  const sentByYou = ev("human_sent");
  const cost = (store.db.query("SELECT COALESCE(SUM(CAST(detail AS REAL)), 0) s FROM events WHERE kind = 'cost' AND at >= ?").get(since) as { s: number }).s;
  const closedWithoutYou = closed - touchedClosed;
  return {
    days,
    arrived,
    closed,
    closedWithoutYou,
    resolvedWithoutYou: closedWithoutYou + neededYou ? closedWithoutYou / (closedWithoutYou + neededYou) : null,
    neededYou,
    sentByFleet: sent - sentByYou,
    sentByYou,
    approvedUnchanged: count(
      `SELECT COUNT(*) n FROM events e WHERE e.kind = 'human_sent' AND e.at >= ?
       AND NOT EXISTS (SELECT 1 FROM events c WHERE c.card_id = e.card_id AND c.kind = 'correction')`,
      since,
    ),
    corrections: ev("correction"),
    repair: count("SELECT COUNT(*) n FROM cards WHERE state = 'repair'"),
    costUsd: Math.round(cost * 100) / 100,
    costPerResolved: closed ? Math.round((cost / closed) * 100) / 100 : null,
  };
}

export function formatMetrics(m: Metrics): string {
  const pct = m.resolvedWithoutYou === null ? "n/a" : `${Math.round(m.resolvedWithoutYou * 100)}%`;
  const lines = [
    `Last ${m.days} days`,
    "",
    `  resolved without you   ${pct}   (${m.closedWithoutYou} closed alone, ${m.neededYou} needed you)`,
    `  needed you             ${m.neededYou}`,
    `  arrived                ${m.arrived}`,
    `  sent by the fleet 🤖   ${m.sentByFleet}   (by you: ${m.sentByYou})`,
    `  drafts you approved    ${m.approvedUnchanged} of ${m.sentByYou} unchanged   (high = that level can go to auto)`,
    `  your corrections       ${m.corrections}   (should fall week over week)`,
    `  repair queue           ${m.repair}`,
    `  cost                   $${m.costUsd}${m.costPerResolved !== null ? `   ($${m.costPerResolved} per closed card)` : ""}`,
  ];
  return lines.join("\n");
}
