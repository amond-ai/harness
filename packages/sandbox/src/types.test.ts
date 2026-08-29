/**
 * The contract is types but for two things, and these are they.
 *
 * `run-workflow.ts` branches on `cause instanceof SandboxNoExitRecordError` to tell a turn
 * that vanished without an exit record from one that outlived its budget — the first is a
 * failure to report, the second a process to kill. Both cross a package boundary to get
 * there, so being an ordinary `Error` with a recognisable message is not enough: the class
 * itself has to survive the trip and stay distinguishable from its sibling.
 */
import { describe, expect, it } from 'vitest'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from './types'

describe('SandboxWaitTimeoutError', () => {
  it('carries the process and the budget that elapsed, not a parsed message', () => {
    const error = new SandboxWaitTimeoutError('run-1', 20)

    expect(error).toBeInstanceOf(Error)
    expect(error.processId).toBe('run-1')
    expect(error.elapsedMs).toBe(20)
    // Set explicitly because the class name does not survive minification, and the name is
    // what a structured log line shows for an error nobody caught.
    expect(error.name).toBe('SandboxWaitTimeoutError')
  })
})

describe('SandboxNoExitRecordError', () => {
  it('carries the process that vanished', () => {
    const error = new SandboxNoExitRecordError('run-1')

    expect(error).toBeInstanceOf(Error)
    expect(error.processId).toBe('run-1')
    expect(error.name).toBe('SandboxNoExitRecordError')
  })

  it('is not a wait timeout, so the two outcomes stay separable by `instanceof`', () => {
    expect(new SandboxNoExitRecordError('run-1')).not.toBeInstanceOf(SandboxWaitTimeoutError)
    expect(new SandboxWaitTimeoutError('run-1', 20)).not.toBeInstanceOf(SandboxNoExitRecordError)
  })
})
