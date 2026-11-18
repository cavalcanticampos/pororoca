// What counts as a sensitive change. Pattern from the reference fleet: an additive
// migration is NOT sensitive; treating every migration as sensitive sent most PRs to the human.

export interface Sensitivity {
  sensitive: boolean;
  reasons: string[];
}

const RULES: [RegExp, string][] = [
  [/^\.github\/workflows\//, "CI config"],
  [/(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$/, "CI config"],
  [/\.tf$|\.tfvars$|(^|\/)(terraform|infra|k8s|helm|charts)\//, "infrastructure"],
  [/(^|\/)\.env(\.[^/]*)?$/, "secrets"],
  [/\.(pem|key|p12|pfx)$|(^|\/)(secrets?|credentials?)[^/]*$/i, "secrets"],
];

const MIGRATION = /(^|\/)(migrations?|alembic\/versions|db\/migrate|prisma\/migrations)\//;

/** True when every statement only adds structure. */
export function isAdditiveSql(sql: string): boolean {
  const stmts = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean);
  if (!stmts.length) return false;
  return stmts.every((s) => {
    if (/^(begin|commit)$/.test(s)) return true;
    if (/^create (unique )?index( concurrently)?( if not exists)? /.test(s)) return true;
    if (/^create table( if not exists)? /.test(s)) return true;
    if (/^create (or replace )?policy /.test(s)) return true;
    if (/^comment on /.test(s)) return true;
    const alter = s.match(/^alter table (if exists )?\S+ (.*)$/);
    if (alter) {
      return alter[2]!.split(/,(?![^(]*\))/).every((clause) => {
        const c = clause.trim();
        if (/^add (column )?(if not exists )?\S+ /.test(c)) return !/not null/.test(c) || /default /.test(c);
        if (/^add constraint /.test(c)) return true;
        return false;
      });
    }
    return false;
  });
}

/**
 * Classify a change. `contents` maps a changed path to its new content when the caller
 * has it; a migration whose content is known and additive is not sensitive.
 */
export function classify(files: string[], contents: Record<string, string> = {}): Sensitivity {
  const reasons = new Set<string>();
  for (const f of files) {
    if (/\.env\.(example|sample|template)$/.test(f)) continue;
    for (const [re, why] of RULES) if (re.test(f)) reasons.add(why);
    if (MIGRATION.test(f)) {
      const body = contents[f];
      if (body === undefined || !f.endsWith(".sql") || !isAdditiveSql(body)) reasons.add("destructive or unknown migration");
    }
  }
  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}
