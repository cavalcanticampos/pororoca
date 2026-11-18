import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pororoca-jirau',
  component: 'Pane',
  requestId: 'pororoca-jirau',
  props: {
    title: 'jirau',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SNAPSHOT = JSON.stringify({
  fleet: 'my-fleet',
  running: true,
  pausedUntil: '',
  repair: 0,
  lane: [
    { id: 3, title: 'Renew the vendor? $12k', reason: 'money: needs your signature', draft: '', pr: '', escalated: false },
    { id: 5, title: 'Deploy window?', reason: 'reply ready', draft: 'Friday 14:00 UTC.', pr: '', escalated: false },
  ],
  active: [{ id: 7, title: 'Fix plus emails', state: 'waiting', label: 'waiting on PR #42', stalled: false, since: '2026-11-18T12:00:00Z' }],
  metrics: { resolvedWithoutYou: 0.9, corrections: 1, neededYou: 2 },
  at: '2026-11-18T12:00:00Z',
})

function engine(on: any, calls: string[][], snapshot = SNAPSHOT) {
  on('command.register', () => ({ value: { command: 'jirau' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/fleet' }))
  on('env.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    if (e.argv[1] === 'jirau') return { value: { exitCode: 0, stdout: snapshot, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: `#${e.argv[2]}: ${e.argv[1]} done.`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the pane shows the lane and what the fleet is on, on every surface', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await $.session.start({ cwd: '/fleet', surface: 'terminal', isInteractive: true })
  expect(calls[0]).toEqual(['pororoca', 'jirau', 'snapshot', '--json'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /2 need you/ }))?.text).toContain('2 need you')
    expect(await ui.find({ type: 'Text', text: /Renew the vendor/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting on PR #42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /90% without you/ })).toBeDefined()
    await ui.unmount()
  }
})

test('opening a card and pressing send runs the CLI', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await $.session.start({ cwd: '/fleet', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-5' })
  expect(await ui.find({ type: 'Text', text: /Friday 14:00 UTC/ })).toBeDefined()
  await ui.press({ key: 'send-5' })
  expect(calls.some(c => c.join(' ') === 'pororoca send 5')).toBe(true)
  await ui.unmount()
})

test('/jirau edit runs the CLI with the text', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await $.session.start({ cwd: '/fleet', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'jirau', args: 'edit 5 Friday at 15:00 instead' } as never)
  expect(calls.some(c => c.join('|') === 'pororoca|edit|5|Friday at 15:00 instead')).toBe(true)
  expect(r.text).toContain('edit done')
})

test('without a fleet it stays closed and /jirau says pororoca init', async ($, on) => {
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'jirau' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/somewhere' }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: 'pororoca: no /somewhere/maloca.yaml here. Run `pororoca init` first.', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/somewhere', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'jirau', args: '' } as never)
  expect(r.text).toContain('pororoca init')
})
