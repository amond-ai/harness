import { describe, expect, it } from 'vitest'
import * as claudeCodeEntry from './claude-code'
import * as codexEntry from './codex'
import * as rootEntry from './index'

/*
 * The entry-point split is a bundling property, not a runtime one: each bridge value-imports this
 * package without marking it external, so whatever the entry it reaches for exports is inlined
 * into the `dist/bridge.mjs` that ships in its sandbox image. A zod schema is a `z.object(…)` call
 * a bundler keeps, so the only thing keeping a sandbox free of the other adapter's schemas is
 * which names the entry exports — which is what these assert.
 */
describe('the package\'s entry points', () => {
  it('keeps both adapters out of the root', () => {
    // The regression this guards is one line: an `export * from './protocol'` back on `index.ts`
    // would put Claude's schemas in every bundle that touches the root, silently.
    expect(rootEntry).not.toHaveProperty('startMessageSchema')
    expect(rootEntry).not.toHaveProperty('deferredToolUseSchema')
    expect(rootEntry).not.toHaveProperty('codexTurnHostFinishSchema')
  })

  it('gives each adapter its own start schema under one name', () => {
    // Both are called `startMessageSchema`, which is why they cannot share a namespace: a
    // consumer reaching for one from a single entry would be picking by luck.
    expect(claudeCodeEntry.startMessageSchema).toBeDefined()
    expect(codexEntry.startMessageSchema).toBeDefined()
    expect(claudeCodeEntry.startMessageSchema).not.toBe(codexEntry.startMessageSchema)
  })

  it('carries the shared halves on all three', () => {
    // The split costs a consumer nothing: an adapter entry is the root plus that adapter, so
    // nobody has to import from two places to parse a frame.
    for (const entry of [rootEntry, claudeCodeEntry, codexEntry]) {
      expect(entry.harnessV1StreamPartSchema).toBe(rootEntry.harnessV1StreamPartSchema)
      expect(entry.interruptReasonSchema).toBe(rootEntry.interruptReasonSchema)
    }
  })
})
