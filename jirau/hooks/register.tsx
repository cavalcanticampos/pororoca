// Jirau: the Pororoca cockpit, a pane beside the chat.
// It reads `pororoca jirau snapshot --json` every 10 s and acts on cards through the same CLI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { actionArgv, ago, cut, headline, HELP, isNoFleet, parseCommand, parseSnapshot, type Verb } from './model'

const PANE = 'pororoca-jirau'
const TITLE = 'jirau'
const EVERY_MS = 10_000

const snap = atom({ plugin: 'pororoca-jirau', key: 'snap' } as const, null, { shape: 'snap-1' })
const erro = atom({ plugin: 'pororoca-jirau', key: 'erro' } as const, '')
const quando = atom({ plugin: 'pororoca-jirau', key: 'quando' } as const, '')
const aberto = atom({ plugin: 'pororoca-jirau', key: 'aberto' } as const, null)
const busy = atom({ plugin: 'pororoca-jirau', key: 'busy' } as const, false)
const semFrota = atom({ plugin: 'pororoca-jirau', key: 'semFrota' } as const, false)

// Where the fleet lives and which binary to call. Set in session.start; a reload runs it again.
let bin = 'pororoca'
let dir = ''

async function locate($: EngineInterface) {
  bin = (await $.env.get('POROROCA_BIN')) || 'pororoca'
  dir = (await $.env.get('POROROCA_DIR')) || (await $.session.root())
}

/** Reads the fleet. Resolves whether a fleet was found. */
async function refresh($: EngineInterface): Promise<boolean> {
  if (await read($, busy)) return !(await read($, semFrota))
  await update($, busy, () => true)
  try {
    const r = await $.process.run([bin, 'jirau', 'snapshot', '--json'], { cwd: dir, timeoutMs: 20_000 })
    if (r.exitCode !== 0) {
      if (isNoFleet(r.stderr)) {
        await update($, semFrota, () => true)
        await update($, erro, () => '')
        return false
      }
      throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split('\n').pop())
    }
    const s = parseSnapshot(r.stdout)
    const before = new Set(((await read($, snap))?.lane ?? []).map(c => c.id))
    const arrived = s.lane.filter(c => !before.has(c.id))
    const hadBefore = (await read($, snap)) !== null
    await update($, snap, () => s)
    await update($, semFrota, () => false)
    await update($, erro, () => '')
    const d = new Date()
    await update($, quando, () => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`)
    if (hadBefore && arrived.length > 0) $.ui.toast(`jirau: needs you, #${arrived[0]!.id} ${cut(arrived[0]!.title, 60)}`)
    return true
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    await update($, erro, () =>
      /ENOENT|not found|cannot start/i.test(msg) ? `can't run "${bin}". Install Pororoca or set POROROCA_BIN.` : cut(msg, 200),
    )
    return true
  } finally {
    await update($, busy, () => false)
  }
}

async function act($: EngineInterface, verb: Verb, id: number, text = ''): Promise<string> {
  const r = await $.process.run(actionArgv(bin, { verb, id, text }), { cwd: dir, timeoutMs: 120_000 })
  await refresh($)
  const out = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim()
  if (r.exitCode !== 0) $.ui.toast(`jirau: ${cut(out, 80)}`)
  return out || `${verb} #${id}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await locate($)
    await $.command.register({ name: 'jirau', description: 'Pororoca cockpit: what needs you and what the fleet is doing' })
    // Opens by itself only where a fleet lives, so the mod stays quiet in every other session.
    if (await refresh($)) {
      void $.ui.open({ id: PANE, title: TITLE })
      $.clock.every(EVERY_MS, () => refresh($))
    }
    return next(e)
  })

  on('command.run', { command: 'jirau' }, async ($, e) => {
    if (!dir) await locate($)
    const c = parseCommand(e.args)
    if (c.kind === 'error') return { text: c.message }
    if (c.kind === 'help') return { text: HELP }
    if (c.kind === 'act') return { text: await act($, c.verb, c.id, c.text) }
    const found = await refresh($)
    if (!found)
      return { text: `No Pororoca fleet in ${dir}. Run \`pororoca init\` there, or set POROROCA_DIR to the folder that holds maloca.yaml.` }
    if (c.kind === 'open') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Jirau open.' }
    }
    return { text: 'Refreshed.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snap)
    const falha = await read($, erro)
    const hora = await read($, quando)
    const ocupado = await read($, busy)
    const sel = await read($, aberto)
    const vazio = await read($, semFrota)
    // the pane's own body width, not the terminal's
    const larg = Math.max(24, (e.props?.bodyColumns ?? e.viewport?.columns ?? 50) - 3)
    const now = new Date()

    if (vazio || !s) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="claude" bold>🛖 jirau</Text>
          {falha !== '' ? <Text color="error">⚠ {cut(falha, larg)}</Text> : null}
          <Text dimColor>{vazio ? `No Pororoca fleet in ${cut(dir, larg - 22)}.` : 'Reading the fleet…'}</Text>
          {vazio ? <Text dimColor>Run `pororoca init` there, or set POROROCA_DIR.</Text> : null}
        </Box>
      )
    }

    const n = s.lane.length
    const pct = s.resolvedWithoutYou === null ? '' : `${Math.round(s.resolvedWithoutYou * 100)}% without you`
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text color="claude" bold>🛖 {cut(s.fleet, 20)}</Text>
            <Text color={s.pausedUntil || s.repair ? 'warning' : s.running ? 'success' : 'subtle'}>{headline(s)}</Text>
          </Box>
          <Button key="refresh" plain hotkey="r" onPress={() => void refresh($)}>
            <Text dimColor>{ocupado ? '↻ …' : `↻ ${hora || '--:--'}`}</Text>
          </Button>
        </Box>
        <Text color="subtle">{'─'.repeat(larg)}</Text>
        {falha !== '' ? <Text color="error">⚠ {cut(falha, larg)}</Text> : null}

        <Text color={n === 0 ? 'success' : 'error'} bold>{n === 0 ? '✋ nothing needs you' : `✋ ${n} need${n === 1 ? 's' : ''} you`}</Text>
        {s.lane.map(c => {
          const open = sel === c.id
          return (
            <Box key={`lane-${c.id}`} flexDirection="column" marginTop={1}>
              <Button key={`toggle-${c.id}`} plain onPress={() => void update($, aberto, a => (a === c.id ? null : c.id))}>
                <Text color={c.escalated ? 'warning' : 'error'}>{open ? '▾' : '●'}</Text>
                <Text bold={open}> #{c.id} {cut(c.title, larg - 8)}</Text>
              </Button>
              <Box paddingLeft={2}>
                <Text dimColor>{cut(c.escalated ? `chased without progress · ${c.reason}` : c.reason, larg - 2)}</Text>
              </Box>
              {open ? (
                <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginLeft={2}>
                  {c.draft !== '' ? (
                    <Box flexDirection="column">
                      <Text color="claude" bold>Draft</Text>
                      <Text>{cut(c.draft, 600)}</Text>
                    </Box>
                  ) : null}
                  {c.pr !== '' ? <Text color="suggestion" underline>{c.pr}</Text> : null}
                  <Box flexDirection="row" gap={2} marginTop={1}>
                    {c.draft !== '' ? (
                      <Button key={`send-${c.id}`} onPress={() => void act($, 'send', c.id)}>
                        <Text color="success">send</Text>
                      </Button>
                    ) : null}
                    {c.pr !== '' ? (
                      <Button key={`merge-${c.id}`} onPress={() => void act($, 'merge', c.id)}>
                        <Text color="success">merge</Text>
                      </Button>
                    ) : null}
                    <Button key={`later-${c.id}`} onPress={() => void act($, 'later', c.id)}>
                      <Text>later</Text>
                    </Button>
                    <Button key={`ignore-${c.id}`} onPress={() => void act($, 'ignore', c.id)}>
                      <Text dimColor>ignore</Text>
                    </Button>
                  </Box>
                  <Text dimColor>/jirau edit {c.id} &lt;your text&gt; · /jirau decide {c.id} &lt;what to do&gt;</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}

        <Box marginTop={1}>
          <Text color="subtle">{'─'.repeat(larg)}</Text>
        </Box>
        <Text color="claude" bold>🌊 the fleet is on {s.active.length}</Text>
        {s.active.length === 0 ? <Text dimColor>Nothing in flight.</Text> : null}
        {s.active.map(c => (
          <Box key={`act-${c.id}`} flexDirection="row" gap={1}>
            <Text color={c.stalled ? 'warning' : 'subtle'}>{c.stalled ? '⚠' : '·'}</Text>
            <Text dimColor>#{c.id}</Text>
            <Text color={c.stalled ? 'warning' : 'text'}>{cut(c.label, 22)}</Text>
            <Text dimColor>{cut(`${c.title}${c.since ? ` · ${ago(c.since, now)}` : ''}`, Math.max(10, larg - 30))}</Text>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor italic>{[pct, s.corrections ? `${s.corrections} corrections this week` : '', 'r refreshes'].filter(Boolean).join(' · ')}</Text>
        </Box>
      </Box>
    )
  })
}
