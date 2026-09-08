import { describe, expect, it } from 'vitest'
import { maskPersistedText, REDACTED, sanitizeDiagnostic } from './redact'

const INSTALLATION_TOKEN = 'ghs_TESTONLYtoken0000'
const PERSONAL_ACCESS_TOKEN = 'github_pat_TESTONLYpersonal0000'
const WEBHOOK_SECRET = 'webhook_TESTONLYsecret0000'
const MODEL_CREDENTIAL = 'sk-ant-TESTONLYmodel0000'
const PRIVATE_KEY = [
  '-----BEGIN TEST PRIVATE KEY-----',
  'VEVTVE9OTFlwcml2YXRla2V5',
  '-----END TEST PRIVATE KEY-----',
].join('\n')
/** The same key as a log that escaped its line breaks instead of emitting them spells it. */
const ESCAPED_PRIVATE_KEY = PRIVATE_KEY.replaceAll('\n', String.raw`\n`)

const PROTECTED_VALUES = new Set([
  PRIVATE_KEY,
  INSTALLATION_TOKEN,
  PERSONAL_ACCESS_TOKEN,
  WEBHOOK_SECRET,
  MODEL_CREDENTIAL,
])

describe('sanitizeDiagnostic', () => {
  it('masks every configured protected value while preserving the diagnostic', () => {
    const diagnostic = [
      `installation failed with ${INSTALLATION_TOKEN}`,
      `PAT ${PERSONAL_ACCESS_TOKEN} was rejected`,
      `signing key:\n${PRIVATE_KEY}`,
      `webhook signature ${WEBHOOK_SECRET} did not match`,
      `model request using ${MODEL_CREDENTIAL} failed`,
    ].join('\n')

    const sanitized = sanitizeDiagnostic(diagnostic, PROTECTED_VALUES, 2_000)

    expect(sanitized).toBe([
      `installation failed with ${REDACTED}`,
      `PAT ${REDACTED} was rejected`,
      `signing key:\n${REDACTED}`,
      `webhook signature ${REDACTED} did not match`,
      `model request using ${REDACTED} failed`,
    ].join('\n'))
    for (const protectedValue of PROTECTED_VALUES) {
      expect(sanitized).not.toContain(protectedValue)
    }
  })

  it('masks a protected value crossing the truncation boundary before bounding the result', () => {
    const bound = 40
    const prefix = `${'context'.repeat(4)}: `
    const diagnostic = `${prefix}${INSTALLATION_TOKEN} trailing detail`

    const sanitized = sanitizeDiagnostic(diagnostic, PROTECTED_VALUES, bound)

    expect(prefix.length).toBe(30)
    expect(diagnostic.slice(0, bound)).toContain(INSTALLATION_TOKEN.slice(0, 10))
    expect(sanitized).toHaveLength(bound)
    expect(sanitized).toBe(`${prefix}${REDACTED}`)
    for (let length = 1; length <= INSTALLATION_TOKEN.length; length++) {
      expect(sanitized).not.toContain(INSTALLATION_TOKEN.slice(0, length))
    }
  })

  it('masks a configured value split across a line break', () => {
    const splitToken = `${INSTALLATION_TOKEN.slice(0, 12)}\n${INSTALLATION_TOKEN.slice(12)}`

    expect(sanitizeDiagnostic(`response: ${splitToken} rejected`, PROTECTED_VALUES, 500))
      .toBe(`response: ${REDACTED} rejected`)
  })

  it('masks a configured value embedded in URL userinfo', () => {
    const diagnostic = `fetch https://user:${INSTALLATION_TOKEN}@host.example/private failed`

    expect(sanitizeDiagnostic(diagnostic, PROTECTED_VALUES, 500))
      .toBe(`fetch https://user:${REDACTED}@host.example/private failed`)
  })

  it('masks a value stored with LF against a diagnostic a transport re-wrote as CRLF', () => {
    const carriageReturned = PRIVATE_KEY.replaceAll('\n', '\r\n')

    expect(sanitizeDiagnostic(`signing failed:\r\n${carriageReturned}\r\n`, PROTECTED_VALUES, 2_000))
      .toBe(`signing failed:\r\n${REDACTED}\r\n`)
  })

  it('masks a value whose line breaks a diagnostic escaped rather than emitted', () => {
    const diagnostic = `request body: {"key":"${ESCAPED_PRIVATE_KEY}"}`

    expect(sanitizeDiagnostic(diagnostic, PROTECTED_VALUES, 2_000))
      .toBe(`request body: {"key":"${REDACTED}"}`)
  })

  it('masks a diagnostic whose line breaks are real when the configured value escaped them', () => {
    const escapedOnly = new Set([ESCAPED_PRIVATE_KEY])

    expect(sanitizeDiagnostic(`signing key:\n${PRIVATE_KEY}`, escapedOnly, 2_000))
      .toBe(`signing key:\n${REDACTED}`)
  })

  it('masks the longest configured value when a shorter one is its prefix', () => {
    // The prefix is configured first, so only ordering by length keeps the suffix from surviving.
    const overlapping = new Set([INSTALLATION_TOKEN.slice(0, 8), INSTALLATION_TOKEN])

    expect(sanitizeDiagnostic(`token ${INSTALLATION_TOKEN} rejected`, overlapping, 500))
      .toBe(`token ${REDACTED} rejected`)
  })

  it('leaves the diagnostic whole when a configured value is nothing but line breaks', () => {
    const diagnostic = 'no credential material here'

    expect(sanitizeDiagnostic(diagnostic, new Set(['', '\n', '\r\n', String.raw`\n`]), 500))
      .toBe(diagnostic)
  })

  /**
   * Reversed in T022, deliberately. This used to assert that a credential-shaped value the
   * caller did not configure came through whole — a defensible reading of "mask what you were
   * told" that the audit showed to be the leak itself: the code that logs a caught error is
   * almost never the code that holds the secrets, and `run-prompt.ts` passed `[]`.
   */
  it('masks a credential-shaped value even when it was not among the protected ones', () => {
    const unconfigured = 'ghs_TESTONLYnotConfigured9999'

    expect(sanitizeDiagnostic(`request with ${unconfigured} returned 401`, PROTECTED_VALUES, 500))
      .toBe(`request with ${REDACTED} returned 401`)
  })

  /**
   * Order between the shapes is load-bearing, not cosmetic.
   *
   * A prefix pattern that fires inside an assertion replaces the segment it matched with
   * `[redacted]` and destroys the `seg.seg.seg` shape, leaving the other two segments verbatim
   * for a pattern that cannot see base64url. Only running the assertion shape first — it is the
   * most specific, and it consumes the whole value as one match — makes this collapse to one
   * mask.
   */
  it('masks an assertion whose first segment also looks like a GitHub token', () => {
    const interfering = 'ghs_abcdefghijklmnopqrstuvwxyz.payloadpayloadpayloadpayload.signaturesignaturesignature'

    expect(sanitizeDiagnostic(`auth failed: ${interfering}`, [], 500)).toBe(`auth failed: ${REDACTED}`)
  })

  /**
   * The two base64 alphabets overlap, and a value may only be decided once.
   *
   * `+` and `/` are inside the opaque class and outside base64url's. Deciding the two shapes in
   * two passes cuts a standard-base64 value in half: the first pass masks the run up to the
   * first `+` or `/`, and the remainder is a fresh run too short for the second pass to reach.
   * That is not hypothetical — it shipped, and against a real 2048-bit key ten of twenty-five
   * PEM body lines reached `error_summary` carrying 260 characters of key material.
   *
   * Both values below are generated rather than typed: the secret is `randomBytes(32)` in
   * standard base64, redrawn until the draw carried both characters *and* survived the masker;
   * the body line is the first line of a throwaway 2048-bit PKCS#1 key, discarded after copying.
   * A hand-typed one proves nothing here — the whole defect is that the natural way to write a
   * base64 sentinel by hand avoids exactly the two characters that break it.
   */
  it('masks a standard-base64 secret carrying both characters base64url spells differently', () => {
    const secret = 'Q/U7Y6JqN4pvXlcZWIqcEWVlgsnSBbe5yD+X67Eg5us='

    expect(sanitizeDiagnostic(`signature check failed for ${secret}`, [], 500))
      .toBe(`signature check failed for ${REDACTED}`)
  })

  it('masks a private key body line carrying both of them', () => {
    const bodyLine = 'MIIEogIBAAKCAQEAuNNjvu3lbb6Ng6ikgBEy/kM/SH9Q7HLaqn6mhyLe+glCAcdv'

    expect(sanitizeDiagnostic(`signing failed near ${bodyLine}`, [], 500))
      .toBe(`signing failed near ${REDACTED}`)
  })

  /**
   * The other half of the base64url shape: what it must *not* eat.
   *
   * The run it matches — 32-plus word characters and hyphens — is also the shape of a long
   * identifier, and masking those would gut the diagnostics this module exists to keep
   * readable. Both exemptions the discriminator is built around are pinned here: a single-case
   * SCREAMING_SNAKE constant, and a mixed-case identifier carrying an underscore.
   *
   * A purely alphabetic identifier of this length (`buildRepositoryMaterializationPlan`) is not
   * among them: {@link OPAQUE_CLASS} has masked those since before this shape existed,
   * because its class is case-insensitive. That trade-off is older than this test and this
   * change neither widens nor narrows it.
   */
  it('leaves a long identifier readable', () => {
    for (const identifier of [
      'someVeryLongCamelCase_identifierName',
      'INSTALLATION_TOKEN_EXPIRY_MARGIN_MS',
      'factory_definition_credential_material',
      'Cf-Access-Authenticated-User-Email',
    ]) {
      expect(sanitizeDiagnostic(`failed at ${identifier}`, [], 500)).toBe(`failed at ${identifier}`)
    }
  })

  /**
   * And why passing the values still matters: shape matching cannot recognise a credential
   * whose shape it does not know. A webhook secret is whatever an operator typed.
   */
  it('needs the value for a secret that looks like ordinary text', () => {
    const shapeless = 'correct horse battery staple'

    expect(sanitizeDiagnostic(`signature check failed for ${shapeless}`, [shapeless], 500))
      .toBe(`signature check failed for ${REDACTED}`)
    expect(sanitizeDiagnostic(`signature check failed for ${shapeless}`, [], 500))
      .toContain(shapeless)
  })
})

/**
 * The masking pass without either of `sanitizeErrorSummary`'s bounds, for text that is *stored*
 * rather than summarised (#205).
 *
 * The sentinels are shaped like the real credentials and drawn from the real alphabets, for the
 * reason `diagnostic-audit.test.ts` records at length: a fixture spelled in `x`es, or in the half
 * of base64 that happens to look like base64url, passes while the value it stands for walks
 * through.
 */
describe('maskPersistedText', () => {
  const INSTALLATION = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a'
  const MODEL_KEY = 'sk-ant-api03-nOtaReAlKeYnOtaReAlKeYnOtaReAlKeYnOtaReAlKeY'
  const ASSERTION = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJJdjIzbGlOb3RBUmVhbEFwcElkIiwiaWF0IjoxNzAwMDAwMDAwfQ.xdcUhPjPm_S3b0eQRzCAS54yJanxM7XeoWj04oUfBy_MAPyqfKYgYXF6SOUuKaP6N5qVP6pok-MuxaJ7lF5gXxCF8yMt'
  /** Prose the masker has no shape for, so what survives proves the text survived and not the mask. */
  const PROSE = 'The reconcile pass reads the board and writes what it read. '.repeat(20)

  it('keeps text past the summary bound whole, byte for byte', () => {
    expect(PROSE.length).toBeGreaterThan(500)
    expect(maskPersistedText(PROSE)).toBe(PROSE)
  })

  it.each([
    ['an installation token', INSTALLATION],
    ['a model credential', MODEL_KEY],
    ['a signed assertion', ASSERTION],
  ])('masks %s sitting past the summary bound', (_kind, sentinel) => {
    const masked = maskPersistedText(`${PROSE}and then it failed with ${sentinel}\n`)

    expect(masked).toBe(`${PROSE}and then it failed with ${REDACTED}\n`)
  })

  it('collapses a line naming a credential wherever in the text it sits', () => {
    expect(maskPersistedText(`${PROSE}\nexport GH_TOKEN=${INSTALLATION}\nthen re-run`))
      .toBe(`${PROSE}\n${REDACTED}\nthen re-run`)
  })

  it('reads absent and blank input as no value at all, like the summariser', () => {
    expect(maskPersistedText(null)).toBeNull()
    expect(maskPersistedText(undefined)).toBeNull()
    expect(maskPersistedText('')).toBeNull()
    expect(maskPersistedText('   \n\t ')).toBeNull()
  })
})
