import { createServer, type IncomingHttpHeaders } from "node:http"
import { connect } from "node:net"
import type { Duplex } from "node:stream"

/** A loopback-only CONNECT fixture. Even a forged target cannot reach an
 * external server: every accepted tunnel goes to the test's supplied port. */
export async function botProxyFixture(targetPort: number, authorization?: string) {
  const tunnels: { target: string; headers: IncomingHttpHeaders }[] = []
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
  }
  const proxy = createServer((_request, response) => response.writeHead(405).end())
  proxy.on("connect", (request, socket, head) => {
    track(socket)
    tunnels.push({ target: request.url ?? "", headers: request.headers })
    if (authorization && request.headers["proxy-authorization"] !== authorization) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n")
      return
    }
    const upstream = connect(targetPort, "127.0.0.1")
    track(upstream)
    socket.once("close", () => upstream.destroy())
    upstream.once("close", () => socket.destroy())
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  return {
    port: (proxy.address() as { port: number }).port,
    tunnels,
    async close() {
      for (const socket of sockets) socket.destroy()
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  }
}
