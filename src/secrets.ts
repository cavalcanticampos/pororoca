// Secrets live in <state>/secrets.env (mode 0600), never in maloca.yaml, cards or PRs.
// Environment variables win over the file.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = (stateDir: string) => join(stateDir, "secrets.env");

export function readSecrets(stateDir: string): Record<string, string> {
  const f = file(stateDir);
  if (!existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function secret(stateDir: string, key: string): string | undefined {
  return process.env[key] || readSecrets(stateDir)[key] || undefined;
}

export function saveSecret(stateDir: string, key: string, value: string): void {
  if (!/^[A-Z0-9_]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("invalid secret");
  mkdirSync(stateDir, { recursive: true });
  const all = { ...readSecrets(stateDir), [key]: value };
  writeFileSync(file(stateDir), Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file(stateDir), 0o600);
}
