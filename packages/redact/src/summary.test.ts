import { describe, expect, it } from 'vitest'
import { REDACTED } from './redact'
import { sanitizeErrorSummary, SUMMARY_MAX_LENGTH } from './summary'

describe('sanitizeErrorSummary', () => {
  it('truncates a long stderr to the shared summary bound', () => {
    const stderr = 'attempt failed at step: connection reset by peer\n'.repeat(30)
    const summary = sanitizeErrorSummary(stderr)

    expect(stderr.length).toBeGreaterThan(SUMMARY_MAX_LENGTH)
    expect(summary).toHaveLength(SUMMARY_MAX_LENGTH)
    expect(summary).toBe(stderr.slice(0, SUMMARY_MAX_LENGTH))
  })

  it('strips whole lines that mention a credential env name', () => {
    const summary = sanitizeErrorSummary([
      'attempt failed',
      'CLAUDE_CODE_OAUTH_TOKEN=oat-01-not-a-real-token',
      '  env ANTHROPIC_API_KEY is set',
      'ANTHROPIC_BASE_URL=https://gateway.example/api',
      'GH_TOKEN=abc123',
      'MY_SERVICE_SECRET: hunter2',
      'exit code 1',
    ].join('\n'))

    expect(summary).toBe([
      'attempt failed',
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      'exit code 1',
    ].join('\n'))
  })

  it('masks token-like values that appear without a credential name', () => {
    const summary = sanitizeErrorSummary('auth rejected for sk-ant-api03-AbCdEf0123456789 while polling')

    expect(summary).toBe(`auth rejected for ${REDACTED} while polling`)
    expect(summary).not.toContain('sk-ant')
  })

  it('masks long base64 and hex runs', () => {
    const summary = sanitizeErrorSummary(`token ${'A1b2C3d4'.repeat(6)} and ${'deadbeef'.repeat(5)}`)

    expect(summary).toBe(`token ${REDACTED} and ${REDACTED}`)
  })

  it('leaves ordinary diagnostics untouched', () => {
    const raw = 'attempt 2 timed out after 300000ms (exit code 143)'

    expect(sanitizeErrorSummary(raw)).toBe(raw)
  })

  it('truncates after redaction so a redacted line can never be cut open', () => {
    const summary = sanitizeErrorSummary(`ANTHROPIC_API_KEY=${'x'.repeat(SUMMARY_MAX_LENGTH * 2)}`)

    expect(summary).toBe(REDACTED)
  })

  it('returns null for absent or empty input', () => {
    expect(sanitizeErrorSummary(null)).toBeNull()
    expect(sanitizeErrorSummary(undefined)).toBeNull()
    expect(sanitizeErrorSummary('   ')).toBeNull()
  })

  it('bounds a very large input before scanning it for redaction', () => {
    const line = 'benign diagnostic line with no secrets in it'
    const raw = `${line}\n`.repeat(3000) // well past the 64 KiB scan bound
    expect(raw.length).toBeGreaterThan(64 * 1024)

    const summary = sanitizeErrorSummary(raw)

    // Unaffected by the bound: the first SUMMARY_MAX_LENGTH characters sit entirely
    // inside it, so the bounded-then-redacted result matches a plain truncation.
    expect(summary).toHaveLength(SUMMARY_MAX_LENGTH)
    expect(summary).toBe(raw.slice(0, SUMMARY_MAX_LENGTH))
  })

  it('never lets a credential on a line beyond the scan bound leak into the sanitized output', () => {
    const filler = 'benign diagnostic line with no secrets in it\n'.repeat(3000) // > 64 KiB
    expect(filler.length).toBeGreaterThan(64 * 1024)
    const raw = `${filler}ANTHROPIC_API_KEY=sk-ant-should-never-appear-in-output`

    const summary = sanitizeErrorSummary(raw)

    // The credential's line is dropped by the pre-redaction bound before it is ever
    // scanned — it must not appear, redacted or otherwise, in the sanitized output.
    expect(summary).not.toContain('sk-ant-should-never-appear-in-output')
    expect(summary).not.toContain('ANTHROPIC_API_KEY')
  })

  it('keeps existing redaction and truncation behavior unchanged for input within the bound', () => {
    const raw = [
      'connecting to sandbox',
      'CLAUDE_CODE_OAUTH_TOKEN=oat-01-not-a-real-token',
      'retrying in 5s',
    ].join('\n')

    expect(sanitizeErrorSummary(raw)).toBe([
      'connecting to sandbox',
      REDACTED,
      'retrying in 5s',
    ].join('\n'))
  })

  it('still summarizes a single-line blob whose only newline sits before the summary length', () => {
    // A newline-led blob would cut to the empty string if the newline were trusted blindly:
    // `lastIndexOf` finds index 0, and slicing there loses the whole diagnostic (#75 review).
    const raw = `\n${'sandbox stderr chatter '.repeat(4000)}`
    expect(raw.length).toBeGreaterThan(64 * 1024)

    const summary = sanitizeErrorSummary(raw)

    expect(summary).toHaveLength(SUMMARY_MAX_LENGTH)
    expect(summary).toContain('sandbox stderr chatter')
  })

  it('drops the token fragment a hard cut would otherwise leave at the bound', () => {
    // One line, no newline anywhere, so the bound has to hard-cut. The run ahead of the cut
    // collapses to a single [redacted], which is what pulls whatever follows it into the
    // stored 500 characters — the exact slide the pre-redaction bound must not enable.
    const bound = 64 * 1024
    const token = 'dEaDbEeF'.repeat(5) // 40 chars: long enough to be a real token
    const opaqueRun = 'x'.repeat(bound - token.length - 1 + 10)
    const raw = `${opaqueRun} ${token}`
    expect(raw.length).toBeGreaterThan(bound)

    const summary = sanitizeErrorSummary(raw)

    // A hard cut leaves `dEaDbEeFdE` — 10 characters, under SECRET_RUN's 32, so
    // redaction would pass it through and it would sit right after the collapsed run.
    expect(summary).toBe(`${REDACTED} `)
    expect(summary).not.toContain('dEaDbEeF')
  })
})
