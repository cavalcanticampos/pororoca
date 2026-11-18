// Minimal five-field cron matcher: minute hour day-of-month month day-of-week.
// Supports `*`, `*/n`, `a`, `a-b`, `a-b/n` and comma lists. Enough for agent schedules.

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const [, base, stepRaw] = m;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (base !== "*") {
      const [a, b] = base!.split("-").map(Number);
      lo = a!;
      hi = b ?? (stepRaw ? max : a!);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function validCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => parseField(f, RANGES[i]!) !== null);
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return fields.every((f, i) => parseField(f, RANGES[i]!)?.has(values[i]!) ?? false);
}
