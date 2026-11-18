// `pororoca connect github|slack`: each connection is tested before it is saved.

import { writeFileSync } from "node:fs";
import { SlackApi } from "./adapters/slack.ts";
import { realExec, type Exec } from "./adapters/types.ts";
import { loadMaloca, malocaToYaml } from "./maloca.ts";
import { saveSecret, secret } from "./secrets.ts";

export interface ConnectResult {
  ok: boolean;
  lines: string[];
}

export async function connectGithub(o: { malocaPath: string; repos: string[]; exec?: Exec }): Promise<ConnectResult> {
  const exec = o.exec ?? realExec;
  const lines: string[] = [];
  const auth = await exec(["gh", "auth", "status"]).catch(() => ({ code: 127, out: "", err: "" }));
  if (auth.code !== 0) return { ok: false, lines: [auth.code === 127 ? "gh is not installed: https://cli.github.com" : "gh is not logged in: run `gh auth login`"] };
  const m = loadMaloca(o.malocaPath);
  const gh = (m["x-maloca"].github ??= { repos: [], label: "pororoca" });
  const label = gh.label ?? "pororoca";
  for (const repo of o.repos) {
    const v = await exec(["gh", "repo", "view", repo, "--json", "nameWithOwner,viewerPermission"]);
    if (v.code !== 0) return { ok: false, lines: [...lines, `can't see ${repo}: ${v.err.trim()}`] };
    const perm = (JSON.parse(v.out) as { viewerPermission: string }).viewerPermission;
    if (!["ADMIN", "MAINTAIN", "WRITE"].includes(perm)) return { ok: false, lines: [...lines, `${repo}: your permission is ${perm}; the fleet needs write`] };
    const l = await exec(["gh", "label", "create", label, "-R", repo, "--color", "0f6b5c", "--description", "work for the Pororoca fleet"]);
    lines.push(`✅ ${repo} (${perm.toLowerCase()})${l.code === 0 ? `, label "${label}" created` : ""}`);
    gh.repos = [...new Set([...(gh.repos ?? []), repo])];
  }
  writeFileSync(o.malocaPath, malocaToYaml(m));
  lines.push(`The fleet works open issues labelled "${label}" in ${gh.repos!.join(", ")}.`);
  return { ok: true, lines };
}

export async function connectSlack(o: {
  malocaPath: string;
  stateDir: string;
  token?: string;
  as?: "human" | "bot";
  channels?: string[];
  api?: SlackApi;
}): Promise<ConnectResult> {
  const token = o.token ?? secret(o.stateDir, "SLACK_TOKEN");
  if (!token) return { ok: false, lines: ["no token. Create the app with `pororoca connect slack --manifest`, install it, then pass --token"] };
  const as = o.as ?? (token.startsWith("xoxp-") ? "human" : token.startsWith("xoxb-") ? "bot" : null);
  if (!as) return { ok: false, lines: ["the token should start with xoxp- (acts as you) or xoxb- (acts as the app)"] };
  if (as === "human" && token.startsWith("xoxb-")) return { ok: false, lines: ["a bot token (xoxb-) can't act as you; use the user token (xoxp-) or --as bot"] };
  let who: { user: string; team: string };
  try {
    who = await (o.api ?? new SlackApi(token)).call<{ user: string; team: string }>("auth.test");
  } catch (e) {
    return { ok: false, lines: [`Slack refused the token: ${(e as Error).message}`] };
  }
  saveSecret(o.stateDir, "SLACK_TOKEN", token);
  const m = loadMaloca(o.malocaPath);
  m["x-maloca"].slack = { as, ...(o.channels?.length ? { channels: o.channels } : {}) };
  writeFileSync(o.malocaPath, malocaToYaml(m));
  return {
    ok: true,
    lines: [
      `✅ Slack: ${who.team} as ${who.user} (${as === "human" ? "replies go out as you, signed 🤖" : "replies go out as the app"})`,
      "Token saved in .pororoca/secrets.env (mode 600), not in maloca.yaml.",
      "Only messages that arrive from now on become cards: your DMs, group DMs and mentions" + (o.channels?.length ? `, plus mentions in ${o.channels.join(", ")}` : "") + ".",
    ],
  };
}
