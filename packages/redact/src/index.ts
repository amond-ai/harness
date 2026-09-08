/**
 * One list of credential shapes, and the two bounds a durable summary is cut by.
 *
 * A package rather than a module inside the orchestrator because a masker that only one sink
 * knows about is a shape every other sink misses: anything that logs, stores or shows a
 * diagnostic reaches for the same list here.
 */
export {
  describeCause,
  DESCRIBED_CAUSE_MAX_LENGTH,
  maskCredentialLines,
  maskPersistedText,
  maskSecretShapes,
  REDACTED,
  sanitizeDiagnostic,
  sanitizePersistedDiagnostic,
} from './redact'
export { sanitizeErrorSummary, SUMMARY_MAX_LENGTH } from './summary'
