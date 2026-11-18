import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../src/agents.ts";
import { parseArgs } from "../src/cli.ts";
import { cronMatches, validCron } from "../src/cron.ts";
import { checkMaloca, exportOpenRig, malocaToYaml, parseDuration, presetMaloca, validateMaloca } from "../src/maloca.ts";
import { looksLikeLimit } from "../src/runtime.ts";
import { classify, isAdditiveSql } from "../src/sensitive.ts";

const human = { id: "me", name: "Me" };

describe("cron", () => {
  test("matches steps, ranges and lists", () => {
    const d = new Date(2026, 10, 18, 9, 30); // Wed
    expect(cronMatches("*/10 * * * *", d)).toBe(true);
    expect(cronMatches("*/7 * * * *", d)).toBe(false);
    expect(cronMatches("30 9-17 * * 1-5", d)).toBe(true);
    expect(cronMatches("30 9 * * 0,6", d)).toBe(false);
  });
  test("rejects bad expressions", () => {
    expect(validCron("*/5 * * * *")).toBe(true);
    expect(validCron("61 * * * *")).toBe(false);
    expect(validCron("* * *")).toBe(false);
  });
});

describe("maloca", () => {
  test("presets are valid and pass check", () => {
    for (const p of ["solo-dev", "tech-lead", "founder"] as const) {
      const m = presetMaloca(p, human, ["a/b"]);
      expect(validateMaloca(m)).toEqual([]);
      expect(checkMaloca(m)).toEqual([]);
    }
  });
  test("starts safe: shadow on, reply propose, chasing off, sensitive to the human", () => {
    const x = presetMaloca("solo-dev", human)["x-maloca"];
    expect(x.shadow?.enabled).toBe(true);
    expect(x.autonomy.reply).toBe("propose");
    expect(x.autonomy.chase_people).toBe("off");
    expect(x.autonomy.sensitive_change).toBe("human");
  });
  test("round-trips through YAML", () => {
    const m = presetMaloca("tech-lead", human, ["a/b"]);
    expect(Bun.YAML.parse(malocaToYaml(m))).toEqual(m);
  });
  test("check finds the waiting-without-chaser hole", () => {
    const m = presetMaloca("solo-dev", human);
    delete m["x-maloca"].chase.waiting_on_pr;
    expect(checkMaloca(m).join()).toContain('"waiting on a PR" has no chase rule');
  });
  test("check finds a path to the human that skips the gatekeeper", () => {
    const m = presetMaloca("solo-dev", human);
    m.edges.push({ from: "builder", to: "me" });
    expect(checkMaloca(m).join()).toContain("builder -> me reaches the human without the gatekeeper");
  });
  test("check refuses sensitive changes on auto", () => {
    const m = presetMaloca("solo-dev", human);
    m["x-maloca"].autonomy.sensitive_change = "auto";
    expect(checkMaloca(m).join()).toContain("sensitive_change can't be auto");
  });
  test("validate catches bad levels, crons and escalation targets", () => {
    const m = presetMaloca("solo-dev", human) as any;
    m["x-maloca"].autonomy.reply = "yolo";
    m["x-maloca"].agents.triage.schedule = "every minute";
    m["x-maloca"].escalation.to = "boss";
    const errs = validateMaloca(m).join("\n");
    expect(errs).toContain("autonomy.reply");
    expect(errs).toContain("invalid cron");
    expect(errs).toContain("boss is not a declared human");
  });
  test("OpenRig export has no x-* keys", () => {
    const y = exportOpenRig(presetMaloca("solo-dev", human));
    expect(y).not.toContain("x-maloca");
    expect((Bun.YAML.parse(y) as any).pods[0].members.length).toBe(6);
  });
  test("durations", () => {
    expect(parseDuration("60m")).toBe(3_600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("soon")).toBeNaN();
  });
});

describe("sensitive changes", () => {
  test("additive migrations are not sensitive", () => {
    const sql = "CREATE TABLE t (id int); ALTER TABLE u ADD COLUMN note text; CREATE INDEX i ON u(note);";
    expect(isAdditiveSql(sql)).toBe(true);
    expect(classify(["db/migrations/001.sql"], { "db/migrations/001.sql": sql }).sensitive).toBe(false);
  });
  test("destructive or unknown migrations are", () => {
    expect(isAdditiveSql("ALTER TABLE u DROP COLUMN note")).toBe(false);
    expect(isAdditiveSql("ALTER TABLE u ADD COLUMN x int NOT NULL")).toBe(false);
    expect(isAdditiveSql("ALTER TABLE u ADD COLUMN x int NOT NULL DEFAULT 0")).toBe(true);
    expect(classify(["db/migrations/002.sql"], { "db/migrations/002.sql": "DELETE FROM u" }).sensitive).toBe(true);
    expect(classify(["alembic/versions/abc.py"]).sensitive).toBe(true);
  });
  test("CI, infra and secrets are; .env.example is not", () => {
    expect(classify([".github/workflows/ci.yml"]).reasons).toEqual(["CI config"]);
    expect(classify(["infra/main.tf"]).reasons).toEqual(["infrastructure"]);
    expect(classify([".env"]).reasons).toEqual(["secrets"]);
    expect(classify([".env.example", "src/app.ts"]).sensitive).toBe(false);
  });
});

describe("verdicts", () => {
  test("takes the last JSON object, fenced or not", () => {
    expect(parseVerdict<{ a: number }>('thinking {"a":1} then\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseVerdict<{ a: { b: number } }>('done. {"a": {"b": 3}}')).toEqual({ a: { b: 3 } });
    expect(parseVerdict("no json here")).toBeNull();
  });
  test("limit detection", () => {
    expect(looksLikeLimit("Claude AI usage limit reached")).toBe(true);
    expect(looksLikeLimit("You've hit your weekly limit")).toBe(true);
    expect(looksLikeLimit("all good")).toBe(false);
  });
});

describe("cli args", () => {
  test("flags, values and the rest after --", () => {
    const r = parseArgs(["claim", "a/b", "--hours", "2", "--json", "--", "migrating", "db"]);
    expect(r.pos).toEqual(["claim", "a/b"]);
    expect(r.flags).toEqual({ hours: "2", json: true });
    expect(r.rest).toBe("migrating db");
  });
});

test("presets don't share state", () => {
  const a = presetMaloca("solo-dev", human);
  a["x-maloca"].agents.triage!.schedule = "0 0 * * *";
  expect(presetMaloca("solo-dev", human)["x-maloca"].agents.triage!.schedule).toBe("*/5 * * * *");
});
