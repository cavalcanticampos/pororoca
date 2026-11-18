// Shared types for the Pororoca core.

export type Mode = "solo" | "team";

/** What an action may do alone. `human` means it always goes to the human lane. */
export type Level = "off" | "propose" | "judge" | "auto" | "human";

export type Role =
  | "gatekeeper"
  | "triage"
  | "investigator"
  | "builder"
  | "deliverer"
  | "chaser"
  | "judge";

/**
 * Card states. They map onto OpenRig queue item states (see docs/spec/adapters.html):
 * `waiting` is OpenRig `blocked`, and a card waiting on someone is never `done`.
 */
export type CardState =
  | "new" // just arrived, triage has not seen it
  | "gatekeeper" // the gatekeeper is judging (fail-closed: stays here on error)
  | "investigating"
  | "building"
  | "delivering"
  | "waiting" // waiting on a person or a PR; the chaser owns it
  | "you" // the human lane
  | "repair" // technical failures the fleet must fix itself
  | "later"
  | "ignored"
  | "done";

export const ACTIVE_STATES: CardState[] = ["new", "gatekeeper", "investigating", "building", "delivering"];
export const CLOSED_STATES: CardState[] = ["done", "ignored"];

export interface Card {
  id: number;
  source: string;
  ext_id: string | null;
  repo: string | null;
  title: string;
  body: string;
  state: CardState;
  kind: string | null;
  reason: string | null;
  draft: string | null;
  waiting_on: string | null;
  waiting_kind: "person" | "pr" | null;
  pr_url: string | null;
  attempts: number;
  chases: number;
  last_chase: string | null;
  escalated: number;
  created_at: string;
  updated_at: string;
}

export interface CardEvent {
  id: number;
  card_id: number;
  at: string;
  kind: string;
  detail: string | null;
}
