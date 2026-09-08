/**
 * Where a bridge is, as a backend's `portEndpoint` answered it.
 *
 * `HarnessV1PortEndpoint` — copied structurally so this package need not depend on the harness,
 * and kept here rather than beside any one opener because it is the *input* every opener takes.
 *
 * `headers` is the part that decides which opener a runtime can use. It is the contract's way of
 * saying "present this credential when you connect", and the standard `WebSocket` constructor
 * takes no request headers at all — so an opener built on it has to refuse a non-empty `headers`
 * rather than drop it (`standard-connect.ts`), while an opener that performs the upgrade over a
 * request can carry it (`@amond-ai/harness-transport-cloudflare`).
 */
export interface BridgeEndpoint {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}
