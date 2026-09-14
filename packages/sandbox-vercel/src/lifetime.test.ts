import { describe, expect, it, vi } from 'vitest'
import { createLifetimeRenewer } from './lifetime'
import { fakeSandbox } from './vercel-sandbox.fake'

const LIFETIME = 60_000

/** A clock the test advances by hand, so hours of waiting cost no wall-clock time. */
function clock(): { now: () => number, advance: (ms: number) => void } {
  let at = 0
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

describe('createLifetimeRenewer', () => {
  it('renews nothing when no lifetime was configured', async () => {
    // A consumer that did not set a lifetime did not ask this package to manage one, and
    // inventing a deadline for a sandbox whose owner deliberately left it unbounded is not a
    // default this can pick.
    const fake = fakeSandbox()
    const renew = createLifetimeRenewer(fake.sandbox, { floorMs: 1_000, elapsedMs: clock().now })

    await renew()
    await renew()
    expect(fake.extended).toEqual([])
  })

  it('leaves a freshly created sandbox alone', async () => {
    // It was created with a full lifetime; `extendTimeout` adds, so there is nothing to add to.
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1_000,
      elapsedMs: time.now,
    })

    await renew()
    expect(fake.extended).toEqual([])
  })

  it('extends once the deadline is less than half a lifetime away', async () => {
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1_000,
      elapsedMs: time.now,
    })

    await renew()
    time.advance(LIFETIME * 0.6)
    await renew()

    expect(fake.extended).toEqual([LIFETIME])
  })

  it('does not accumulate the deadline past the plan\'s cap', async () => {
    // The correction this port exists for. e2b's `setTimeout` re-applies a lifetime; Vercel's
    // `extendTimeout` *adds*, and the sum is capped by the plan's maximum. Asking again while
    // most of a lifetime is still left pushes the deadline past that cap, after which every
    // renewal for the rest of a long turn is a refusal — logged once per probe, while the
    // deadline it was meant to protect stops moving.
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1,
      elapsedMs: time.now,
    })

    await renew()
    time.advance(LIFETIME * 0.6)
    await renew()
    // The deadline now sits two lifetimes from the sandbox's creation, and the clock is at 0.6.
    // Every ask until half a lifetime before it is a skip, however often the caller polls.
    for (let tick = 0; tick < 8; tick++) {
      time.advance(LIFETIME / 16)
      await renew()
    }

    expect(fake.extended).toEqual([LIFETIME])
  })

  it('renews again once the extended deadline itself runs down', async () => {
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1,
      elapsedMs: time.now,
    })

    await renew()
    time.advance(LIFETIME * 0.6)
    await renew()
    // The sandbox now stops at two lifetimes, so the next renewal is due at one and a half.
    time.advance(LIFETIME * 0.9)
    await renew()

    expect(fake.extended).toEqual([LIFETIME, LIFETIME])
  })

  it('rate-limits the ask against the lifetime rather than the caller\'s cadence', async () => {
    // `waitForExit` asks on every liveness probe, and renewing an hourly lifetime every five
    // seconds is thousands of round trips for one turn, all but a handful of them redundant.
    const fake = fakeSandbox()
    const time = clock()
    fake.failing.add('never-matches')
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1,
      elapsedMs: time.now,
    })

    await renew()
    time.advance(LIFETIME * 0.6)
    for (let tick = 0; tick < 20; tick++) {
      await renew()
    }

    expect(fake.extended).toEqual([LIFETIME])
  })

  it('swallows a failed renewal, logs it, and does not believe in headroom it did not get', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const time = clock()
    const renewer = createLifetimeRenewer({
      ...fake.sandbox,
      extendTimeout: async () => {
        throw new Error('execution timeout cap reached')
      },
    }, { initialLifetimeMs: LIFETIME, floorMs: 1, elapsedMs: time.now })

    await renewer()
    time.advance(LIFETIME * 0.6)
    // A renewal that did not land is not a reason to abandon a wait over a healthy process, but
    // a silently unrenewed sandbox is the exact failure this call exists to prevent.
    await expect(renewer()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not renew sandbox lifetime'))

    // And the deadline did not move, so the next attempt after the rate limit is not skipped for
    // half a lifetime of headroom that is not there.
    time.advance(LIFETIME / 4)
    await renewer()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('an increment smaller than the lifetime', () => {
  const HALF_HOUR = 1_800_000
  const FIVE_MINUTES = 300_000

  it('leaves a 30-minute sandbox alone until it is within half an increment of stopping', async () => {
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: HALF_HOUR,
      incrementMs: FIVE_MINUTES,
      floorMs: 1_000,
      elapsedMs: time.now,
    })

    // Collapsing the two numbers seeds the deadline from the *increment*, which would put it at
    // `now + 5min` against a sandbox that stops at `now + 30min` — so the renewer would start
    // extending here, 27.5 minutes early, and then again every 75 seconds for the rest of the
    // turn, every call adding to a sum the plan is about to refuse.
    await renew()
    time.advance(HALF_HOUR - FIVE_MINUTES)
    await renew()
    expect(fake.extended).toEqual([])

    // 2.5 minutes before it stops — half an increment — is when one extension is worth making.
    time.advance(FIVE_MINUTES / 2 + 1)
    await renew()
    expect(fake.extended).toEqual([FIVE_MINUTES])
  })

  it('rate-limits on the increment, not the lifetime', async () => {
    const fake = fakeSandbox()
    const time = clock()
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: HALF_HOUR,
      incrementMs: FIVE_MINUTES,
      floorMs: 1_000,
      elapsedMs: time.now,
    })
    await renew()
    time.advance(HALF_HOUR - FIVE_MINUTES / 2 + 1)
    await renew()

    // A quarter of an *increment*, which is the unit both the skip window and the limit are
    // about: how much headroom one call buys, and how often one is worth making.
    time.advance(FIVE_MINUTES / 4 - 1)
    await renew()
    expect(fake.extended).toEqual([FIVE_MINUTES])
    time.advance(FIVE_MINUTES)
    await renew()
    expect(fake.extended).toEqual([FIVE_MINUTES, FIVE_MINUTES])
  })
})

describe('seeding the deadline', () => {
  it('believes Vercel over the configured lifetime', async () => {
    const fake = fakeSandbox()
    const time = clock()
    // The consumer declared 60s and the sandbox was really created with 10s. Declaring a lifetime
    // longer than the truth is the direction that lets the sandbox stop mid-turn, and it is
    // reachable today because the lifetime is declared twice — here and in
    // `VercelApiOptions.create.timeout` — with nothing checking that the two agree.
    fake.expiresAt = new Date(Date.now() + 10_000)
    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1_000,
      elapsedMs: time.now,
    })

    await renew()
    expect(fake.extended).toEqual([LIFETIME])
  })

  it('falls back to the configured lifetime when the API reported no stop time', async () => {
    const fake = fakeSandbox()
    const time = clock()

    const renew = createLifetimeRenewer(fake.sandbox, {
      initialLifetimeMs: LIFETIME,
      floorMs: 1_000,
      elapsedMs: time.now,
    })

    await renew()
    expect(fake.extended).toEqual([])
  })
})
