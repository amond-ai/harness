import { defineConfig } from 'vitest/config'
import { sharedCoverage, sharedInlineDeps } from '../../vitest.shared'

export default defineConfig({
  test: {
    // The suites drive the host from outside its module graph — a real
    // WebSocket server against a fake `Codex` — so they live in `test/`
    // rather than beside the sources.
    include: ['test/**/*.test.ts'],
    server: { deps: { inline: sharedInlineDeps } },
    coverage: { ...sharedCoverage, include: ['src/**'] },
  },
})
