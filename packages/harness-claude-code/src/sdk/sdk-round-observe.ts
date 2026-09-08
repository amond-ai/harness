/**
 * What a round hands to whoever is watching it, and how a watcher ends one.
 *
 * Both of {@link TurnRoundSpec}'s observation members are served here rather than in
 * `sdk-round.ts`, because neither is part of how a round decides anything: one reports a frame
 * the round has already classified, and the other only changes *when* a read gives up. Beside
 * the pump they would grow the module whose subject is the pump.
 */
import type { TurnHostOutboundMessage } from '@amond-ai/harness-protocol'
import type { TurnRoundSpec } from '../turn-driver'
import type { ChannelEnd, TurnChannel } from './sdk-channel'
import { turnHostOutboundMessageSchema } from '@amond-ai/harness-protocol'

/**
 * The next frame, or the abort that ends the round before the slice does.
 *
 * Raced rather than checked between reads: a suspend arriving one millisecond into a liveness
 * slice would otherwise wait the whole of it, and a slice is the interval a healthy turn is
 * sampled at rather than a bound anyone chose for a suspend. The losing read is abandoned, not
 * cancelled — the round closes the socket on its way out and the next one replays from the
 * cursor this one committed, so a frame delivered into the gap is re-sent rather than lost.
 */
export async function nextFrame(
  channel: TurnChannel,
  slice: number,
  signal: AbortSignal | undefined,
): Promise<{ frame: string } | { end: ChannelEnd } | 'aborted'> {
  if (signal === undefined) {
    return await channel.next(slice)
  }
  let listener: (() => void) | undefined
  try {
    return await Promise.race([
      channel.next(slice),
      new Promise<'aborted'>((resolve) => {
        listener = () => resolve('aborted')
        signal.addEventListener('abort', listener, { once: true })
      }),
    ])
  }
  finally {
    if (listener !== undefined) {
      signal.removeEventListener('abort', listener)
    }
  }
}

/**
 * Hand one readable frame to the round's observer, parsed.
 *
 * Parsed a second time rather than threaded out of `classifyFrame`, because the two want
 * different things from the same line: the round wants the reduction it acts on, and an observer
 * wants the frame. Keeping the reduction's shape wide enough to carry both would put the whole
 * union back into a module whose subject is that it does not need one.
 *
 * A frame the schema refuses is dropped in silence. `classifyFrame` has already accepted it —
 * the only frames that reach here and fail are the control acknowledgements it reads as bare
 * liveness — so a warning here would be a second complaint about a line the round handled.
 */
export function reportFrame(
  frame: string,
  seq: number | undefined,
  onFrame: TurnRoundSpec['onFrame'],
): void {
  if (onFrame === undefined) {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(frame)
  }
  catch {
    return
  }
  const validated = turnHostOutboundMessageSchema.safeParse(parsed)
  if (!validated.success) {
    return
  }
  onFrame(validated.data as TurnHostOutboundMessage, seq)
}
