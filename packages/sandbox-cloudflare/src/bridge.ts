/**
 * Relay a container's WebSocket through the Durable Object, so the open bridge keeps the
 * container alive.
 *
 * Cloudflare's `bridge()` from "Keep WebSocket connections open"
 * (https://developers.cloudflare.com/sandbox/previews/#keep-websocket-connections-open). A socket
 * that only passes through the object does not count as activity, so the container would hit its
 * inactivity timeout mid-turn with the harness bridge still open; accepting both ends here makes
 * every frame activity on this object.
 */
export function bridge(upstream: WebSocket): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]

  upstream.binaryType = 'arraybuffer'
  server.binaryType = 'arraybuffer'
  upstream.accept()
  server.accept()

  // A listener that throws drops the connection, so these never throw.
  const relay = (from: WebSocket, to: WebSocket): void => {
    from.addEventListener('message', (event) => {
      try {
        to.send(event.data)
      }
      catch {
        from.close(1011, 'The other side closed')
      }
    })
    from.addEventListener('close', (event) => {
      // 1005 and 1006 report a missing or abnormal close and cannot be sent.
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code
      try {
        to.close(code, event.reason)
      }
      catch {}
    })
  }

  relay(server, upstream)
  relay(upstream, server)

  return new Response(null, { status: 101, webSocket: client })
}
