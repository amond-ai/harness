import { describe, expect, it } from 'vitest'
import {
  bridgeEndpointUrl,
  mintChannelToken,
  readBridgeAnnouncement,
  TURN_HOST_BASE_PORT,
  TURN_HOST_BUNDLE,
  turnHostArgv,
  turnHostEnv,
  turnHostJournalPath,
  turnHostPort,
  turnHostStateDir,
} from './sdk-bridge-config'

describe('where a turn host runs', () => {
  it('offsets the port by the attempt, so a predecessor cannot hold the next one\'s', () => {
    expect(turnHostPort(1)).toBe(TURN_HOST_BASE_PORT + 1)
    expect(turnHostPort(2)).toBe(TURN_HOST_BASE_PORT + 2)
  })

  it('keeps one attempt\'s state beside the checkout rather than inside it', () => {
    const stateDir = turnHostStateDir({ workspaceRoot: '/workspace', runId: 'run-1', attempt: 2 })

    expect(stateDir).toBe('/workspace/.turn-host/run-1/2')
    expect(turnHostJournalPath(stateDir)).toBe('/workspace/.turn-host/run-1/2/event-log.ndjson')
    // Two attempts of one run, and two runs, never share a journal.
    expect(turnHostStateDir({ workspaceRoot: '/workspace', runId: 'run-1', attempt: 1 })).not.toBe(stateDir)
    expect(turnHostStateDir({ workspaceRoot: '/workspace', runId: 'run-2', attempt: 2 })).not.toBe(stateDir)
  })
})

describe('how a turn host is started', () => {
  it('names both hard-fatal flags and keeps the prompt and the token out of argv', () => {
    const argv = turnHostArgv({ workdir: '/workspace/repo', stateDir: '/workspace/.turn-host/run-1/1' })

    expect(argv).toEqual([
      'node',
      TURN_HOST_BUNDLE,
      '--workdir',
      '/workspace/repo',
      '--bridge-state-dir',
      '/workspace/.turn-host/run-1/1',
    ])
    expect(argv.join(' ')).not.toContain('token')
  })

  it('carries the bridge\'s two variables over the environment the caller assembled', () => {
    expect(turnHostEnv({ ANTHROPIC_API_KEY: 'k' }, { token: 'tok', port: 41_001 })).toEqual({
      ANTHROPIC_API_KEY: 'k',
      BRIDGE_CHANNEL_TOKEN: 'tok',
      BRIDGE_WS_PORT: '41001',
    })
  })

  it('mints a 32-byte hex token from the entropy it is handed', () => {
    const token = mintChannelToken(into => into.fill(0xAB))

    expect(token).toBe('ab'.repeat(32))
  })

  it('appends the bridge\'s token parameter without disturbing the routing tag', () => {
    const url = bridgeEndpointUrl('https://sandbox.example/?__pf_sandbox=sandbox-1', 'tok')

    expect(new URL(url).searchParams.get('agent_bridge_token')).toBe('tok')
    expect(new URL(url).searchParams.get('__pf_sandbox')).toBe('sandbox-1')
  })
})

describe('readBridgeAnnouncement', () => {
  it('finds the listening line among whatever else the host printed', () => {
    expect(readBridgeAnnouncement('booting\n{"type":"bridge-ready","port":41001}\n'))
      .toEqual({ status: 'ready', port: 41_001 })
  })

  it('reports a fatal rather than making the caller spend its readiness budget on it', () => {
    expect(readBridgeAnnouncement('{"type":"bridge-fatal","message":"BRIDGE_CHANNEL_TOKEN is required"}'))
      .toEqual({ status: 'fatal', message: 'BRIDGE_CHANNEL_TOKEN is required' })
  })

  it('says nothing about output that is neither', () => {
    expect(readBridgeAnnouncement('starting up\n{"type":"raw"}\n{broken')).toBeUndefined()
  })
})
