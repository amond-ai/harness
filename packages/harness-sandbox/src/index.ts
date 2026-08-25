// @pleaseai/harness-sandbox
//
// The AI SDK harness's `HarnessV1SandboxProvider`, implemented over
// `@pleaseai/sandbox-contract`. Written once against the contract, it serves every backend
// behind it — Cloudflare, e2b, or one that does not exist yet — with no harness-shaped code
// in any of them.

export { createFileSurface, parentDirectory, sliceLines, toBase64 } from './files'
export type { HarnessFileSurface } from './files'

export { createProcessSurface, splitProcessStreams } from './process'
export type { HarnessProcessSurface, ProcessSurfaceOptions, SplitProcessStreams } from './process'

export { createHarnessSandboxProvider } from './provider'
export type { HarnessSandboxProviderOptions } from './provider'

export { createHarnessSandboxSession } from './session'
export type { HarnessSandboxSessionOptions } from './session'
