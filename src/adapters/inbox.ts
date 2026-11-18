// Local inbox: work arrives with `pororoca inbox add`, replies land in the outbox (`pororoca outbox`).

import type { Card } from "../types.ts";
import type { Conversation, Inbound } from "./types.ts";

export class LocalInbox implements Conversation {
  readonly id = "inbox";
  readonly speaksAsHuman = true;
  async fetch(): Promise<Inbound[]> {
    return []; // `inbox add` writes cards straight into the store
  }

  async reply(_card: Card, _text: string): Promise<void> {
    // The fleet records every reply as a "sent" event; `pororoca outbox` reads those.
  }
}
