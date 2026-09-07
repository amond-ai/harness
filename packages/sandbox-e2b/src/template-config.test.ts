import { describe, expect, it } from 'vitest'
import { resolveTemplateBuildConfig } from './template-config'

/** The two credentials plus the api key — everything else has a default. */
const REQUIRED = {
  E2B_API_KEY: 'e2b-key',
  GHCR_USERNAME: 'amondnet',
  GHCR_TOKEN: 'ghp-token',
} as const

describe('resolveTemplateBuildConfig', () => {
  it('defaults to the CI-published image and the alias the Worker names', () => {
    expect(resolveTemplateBuildConfig({ ...REQUIRED })).toEqual({
      source: {
        kind: 'image',
        image: 'ghcr.io/chatbot-pf/pleaseworks-e2b:latest',
        registry: { username: 'amondnet', password: 'ghp-token' },
      },
      alias: 'pleaseworks',
      cpuCount: 2,
      memoryMB: 4096,
    })
  })

  it('takes every default from the environment when it is named', () => {
    expect(resolveTemplateBuildConfig({
      ...REQUIRED,
      E2B_TEMPLATE_IMAGE: 'ghcr.io/chatbot-pf/pleaseworks-e2b:abc1234',
      E2B_TEMPLATE_ALIAS: 'pleaseworks-preview',
      E2B_TEMPLATE_CPU: '4',
      E2B_TEMPLATE_MEMORY_MB: '8192',
    })).toEqual({
      source: {
        kind: 'image',
        image: 'ghcr.io/chatbot-pf/pleaseworks-e2b:abc1234',
        registry: { username: 'amondnet', password: 'ghp-token' },
      },
      alias: 'pleaseworks-preview',
      cpuCount: 4,
      memoryMB: 8192,
    })
  })

  // The promote half of candidate → probe → promote: nothing is pulled, so requiring the
  // registry credentials there would only be a refusal with no build behind it.
  it('builds from a template alias without any GHCR credentials', () => {
    expect(resolveTemplateBuildConfig({
      E2B_API_KEY: 'e2b-key',
      E2B_TEMPLATE_FROM: 'pleaseworks-candidate',
      E2B_TEMPLATE_ALIAS: 'pleaseworks',
      E2B_TEMPLATE_CPU: '4',
      E2B_TEMPLATE_MEMORY_MB: '8192',
    })).toEqual({
      source: { kind: 'template', name: 'pleaseworks-candidate' },
      alias: 'pleaseworks',
      cpuCount: 4,
      memoryMB: 8192,
    })
  })

  it('refuses without the api key', () => {
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, E2B_API_KEY: '  ' }))
      .toThrow(/E2B_API_KEY is not set/)
  })

  // The image is private, so an anonymous pull is not a degraded build — it is one that
  // cannot resolve the image at all, reported by e2b as a build failure naming nothing.
  it('names which of the two GHCR credentials is missing', () => {
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, GHCR_USERNAME: undefined }))
      .toThrow(/GHCR_USERNAME is not set/)
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, GHCR_TOKEN: '' }))
      .toThrow(/GHCR_TOKEN is not set/)
  })

  it('rejects a size that is not a positive integer rather than forwarding a NaN', () => {
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, E2B_TEMPLATE_CPU: '2.5' }))
      .toThrow(/E2B_TEMPLATE_CPU has a non-positive-integer value '2.5'/)
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, E2B_TEMPLATE_MEMORY_MB: '0' }))
      .toThrow(/E2B_TEMPLATE_MEMORY_MB has a non-positive-integer value '0'/)
    // Digits alone are not enough: past the safe range `Number` rounds, and a sandbox spec
    // built from a rounded number is an opaque e2b failure rather than this refusal.
    expect(() => resolveTemplateBuildConfig({ ...REQUIRED, E2B_TEMPLATE_MEMORY_MB: '9007199254740993' }))
      .toThrow(/E2B_TEMPLATE_MEMORY_MB has a non-positive-integer value/)
  })
})
