// The values the Jirau pane keeps in $.state. Same shapes as hooks/model.ts, which the
// pane's pure logic (and its bun tests) use; the contract must not import, so they are spelled here.

declare module 'claude-code' {
  interface PluginState {
    'pororoca-jirau': {
      snap: Shaped<{
        fleet: string
        running: boolean
        pausedUntil: string
        repair: number
        lane: { id: number; title: string; reason: string; draft: string; pr: string; escalated: boolean }[]
        active: { id: number; title: string; label: string; stalled: boolean; since: string }[]
        resolvedWithoutYou: number | null
        corrections: number
        at: string
      } | null>
      erro: string
      quando: string
      aberto: number | null
      busy: boolean
      semFrota: boolean
    }
  }
}
