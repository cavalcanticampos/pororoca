// Pure logic of the Jirau pane: parsing what `pororoca jirau snapshot --json` prints and
// what the person types after `/jirau`. No engine calls here, so it is tested with plain bun.

export type LaneCard = {
  id: number
  title: string
  reason: string
  draft: string
  pr: string
  escalated: boolean
}

export type ActiveCard = {
  id: number
  title: string
  /** The real state, in words: "investigating", "waiting on ana", "building"... never "delivered" while open. */
  label: string
  stalled: boolean
  since: string
}

export type Snapshot = {
  fleet: string
  running: boolean
  pausedUntil: string
  repair: number
  lane: LaneCard[]
  active: ActiveCard[]
  resolvedWithoutYou: number | null
  corrections: number
  at: string
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Reads the CLI's JSON defensively: an older or newer CLI must not break the pane. */
export function parseSnapshot(text: string): Snapshot {
  const o = JSON.parse(text) as Record<string, unknown>
  const lane = Array.isArray(o.lane) ? (o.lane as Record<string, unknown>[]) : []
  const active = Array.isArray(o.active) ? (o.active as Record<string, unknown>[]) : []
  const m = (o.metrics ?? {}) as Record<string, unknown>
  return {
    fleet: str(o.fleet) || 'fleet',
    running: o.running === true,
    pausedUntil: str(o.pausedUntil),
    repair: num(o.repair),
    lane: lane.map(c => ({
      id: num(c.id),
      title: str(c.title),
      reason: str(c.reason),
      draft: str(c.draft),
      pr: str(c.pr),
      escalated: c.escalated === true,
    })),
    active: active.map(c => ({
      id: num(c.id),
      title: str(c.title),
      label: str(c.label) || str(c.state),
      stalled: c.stalled === true,
      since: str(c.since),
    })),
    resolvedWithoutYou: typeof m.resolvedWithoutYou === 'number' ? m.resolvedWithoutYou : null,
    corrections: num(m.corrections),
    at: str(o.at),
  }
}

export const VERBS = ['send', 'edit', 'decide', 'ignore', 'later', 'merge'] as const
export type Verb = (typeof VERBS)[number]
const NEEDS_TEXT: Verb[] = ['edit', 'decide']

export type Command =
  | { kind: 'open' }
  | { kind: 'refresh' }
  | { kind: 'help' }
  | { kind: 'act'; verb: Verb; id: number; text: string }
  | { kind: 'error'; message: string }

export const HELP =
  '/jirau opens the pane · /jirau send N · /jirau edit N <text> · /jirau decide N <text> · /jirau ignore N · /jirau later N · /jirau merge N · /jirau refresh'

/** `/jirau send 3`, `/jirau edit 3 new text`, `/jirau #3 send` is not accepted: verb first. */
export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'open' }
  const [first, second, ...rest] = words
  const verb = first!.toLowerCase()
  if (verb === 'refresh' || verb === 'r') return { kind: 'refresh' }
  if (verb === 'help') return { kind: 'help' }
  if (!(VERBS as readonly string[]).includes(verb)) return { kind: 'error', message: `unknown action "${first}". ${HELP}` }
  const id = Number(String(second ?? '').replace(/^#/, ''))
  if (!Number.isInteger(id) || id <= 0) return { kind: 'error', message: `which card? e.g. /jirau ${verb} 3` }
  const text = rest.join(' ')
  if (NEEDS_TEXT.includes(verb as Verb) && !text) return { kind: 'error', message: `/jirau ${verb} ${id} needs the text` }
  return { kind: 'act', verb: verb as Verb, id, text }
}

/** The CLI argv for an action. */
export function actionArgv(bin: string, c: { verb: Verb; id: number; text: string }): string[] {
  return c.text ? [bin, c.verb, String(c.id), c.text] : [bin, c.verb, String(c.id)]
}

export function cut(t: string, n: number): string {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(1, n - 1)) + '…' : one
}

/** "5m", "3h", "2d" since an ISO time. */
export function ago(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.max(0, Math.round((now.getTime() - t) / 60000))
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

export function headline(s: Snapshot): string {
  const parts = [s.running ? 'running' : 'stopped']
  if (s.pausedUntil) parts.push(`paused until ${s.pausedUntil.slice(11, 16)} (usage limit)`)
  if (s.repair) parts.push(`${s.repair} in repair`)
  return parts.join(' · ')
}

/** Recognises the CLI's "no maloca.yaml" error, so the pane can say `pororoca init` instead of a stack of text. */
export function isNoFleet(stderr: string): boolean {
  return /no .*maloca\.yaml|pororoca init/i.test(stderr)
}
