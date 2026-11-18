// Role prompts and the JSON verdicts each role must end with.
// Agents are autonomous sessions: the prompt states the job and the contract for the last line.

import type { Card } from "./types.ts";

export interface TriageVerdict {
  kind: "question" | "bug" | "request" | "fyi" | "noise";
  repo?: string | null;
  summary: string;
}

export interface GateVerdict {
  needs_human: boolean;
  reason?: string | null;
  why: string;
}

export interface InvestigateVerdict {
  action: "reply" | "build" | "wait" | "done" | "grant_tool";
  reply?: string;
  plan?: string;
  waiting_on?: string;
  waiting_kind?: "person" | "pr";
  /** For grant_tool: a Claude Code tool spec such as Bash(npm run lint:*), and which role needs it. */
  tool?: string;
  tool_role?: string;
}

export interface BuildVerdict {
  /** The builder found an open or merged PR that already solves it. */
  already_done?: string;
  /** The fix isn't code (an operation, a config, an answer). Goes back to the investigator. */
  not_code?: string;
  summary?: string;
}

export interface JudgeVerdict {
  approve: boolean;
  why: string;
}

/** Last JSON object in the text. Agents may think out loud before it. */
export function parseVerdict<T>(text: string): T | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]!);
  const candidates = fenced.length ? fenced : [];
  if (!candidates.length) {
    // walk back from the last closing brace to find a balanced object
    for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
      let depth = 0;
      for (let i = end; i >= 0; i--) {
        if (text[i] === "}") depth++;
        else if (text[i] === "{" && --depth === 0) {
          candidates.push(text.slice(i, end + 1));
          break;
        }
      }
      if (candidates.length) break;
    }
  }
  for (const c of candidates.reverse()) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const card = (c: Card) =>
  `Card #${c.id} (from ${c.source}${c.repo ? `, repo ${c.repo}` : ""})\nTitle: ${c.title}\n${c.body ? `Body:\n${c.body}\n` : ""}`;

export const prompts = {
  triage: (c: Card, repos: string[]) => `You are the triage agent of a Pororoca fleet that works for one busy person.
Classify the incoming item. Known repositories: ${repos.join(", ") || "(none)"}.
${card(c)}
End with one JSON object: {"kind": "question|bug|request|fyi|noise", "repo": "<owner/name or null>", "summary": "<one line>"}`,

  gatekeeper: (c: Card, reasons: string[], decisions: string) => `You are the gatekeeper of a Pororoca fleet. You are the ONLY way into the human's lane.
The human must see a card only when it is about: ${reasons.join(", ")}.
Everything else the fleet handles: investigating, building, answering, chasing. When in doubt, the fleet handles it.
${decisions ? `Past decisions of the human for this repo:\n${decisions}\n` : ""}${card(c)}
End with one JSON object: {"needs_human": true|false, "reason": "<one of the reasons or null>", "why": "<one line>"}`,

  investigator: (c: Card, decisions: string, claims: string) => `You are the investigator of a Pororoca fleet. Find out what is really being asked and what resolves it.
Read the code and history you need. Do not change anything.
${decisions ? `Past decisions of the human for this repo (follow them):\n${decisions}\n` : ""}${claims ? `Work already in flight on this repo (do not duplicate it; if a PR already solves this, reply pointing to it):\n${claims}\n` : ""}${card(c)}
If the request is to let the fleet use a tool it lacks (for example running the linter), use action grant_tool with the narrowest spec.
End with one JSON object:
{"action": "reply|build|wait|done|grant_tool", "tool": "<spec, if grant_tool>", "tool_role": "<builder|investigator|all>", "reply": "<message to send, if any>", "plan": "<what to build, if build>", "waiting_on": "<person or PR, if wait>", "waiting_kind": "person|pr"}`,

  builder: (c: Card, plan: string, decisions: string) => `You are the builder of a Pororoca fleet, working in a fresh git worktree of ${c.repo}.
Make the smallest change that resolves the card, with tests when the repo has them. Do not commit, push or open the PR: the fleet does that.
Never edit CI config, infrastructure or secrets unless the plan says so explicitly.
${decisions ? `Past decisions of the human for this repo:\n${decisions}\n` : ""}${card(c)}
Plan from the investigator:\n${plan}
End with one JSON object: {"summary": "<what changed>"} or {"already_done": "<PR url>"} or {"not_code": "<why this is not a code change>"}`,

  judge: (c: Card, what: string, evidence = "") => `You are the judge of a Pororoca fleet. A sensitive action needs your approval before it happens.
${card(c)}
Action: ${what}
${evidence ? `Evidence (the full change, as text; you don't need tools to read it):\n${evidence}\n` : ""}
Approve only if it is correct, reversible or clearly intended by the requester, and safe.
End with one JSON object: {"approve": true|false, "why": "<one line>"}`,
};
