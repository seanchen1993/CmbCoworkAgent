import { connect, type Socket } from "net"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
  CMB_CHROME_EXTENSION_ORIGIN
} from "../../../src/shared/browser-cookie-bridge"
import { BrowserCookieBridgeServer } from "../../../src/main/browser/chrome/browser-cookie-bridge-server"
import {
  encodeNativeMessage,
  NativeMessageDecoder
} from "../../../src/main/browser/chrome/native-messaging-framing"

const servers: BrowserCookieBridgeServer[] = []
const sockets: Socket[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.stop()
})

function waitForMessage(
  socket: Socket,
  decoder: NativeMessageDecoder
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      try {
        const messages = decoder.push(chunk)
        if (messages.length === 0) return
        cleanup()
        resolve(messages[0] as Record<string, unknown>)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      socket.off("data", onData)
      socket.off("error", onError)
    }
    socket.on("data", onData)
    socket.on("error", onError)
  })
}

describe("browser cookie bridge server", () => {
  it("reports a native host authentication failure before closing the socket", async () => {
    const pipePath = join(tmpdir(), `cmb-cookie-bridge-test-${randomUUID()}.sock`)
    const server = new BrowserCookieBridgeServer(pipePath, "expected-secret")
    servers.push(server)
    await server.start()

    const socket = connect(pipePath)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    const response = waitForMessage(socket, new NativeMessageDecoder())
    socket.write(
      encodeNativeMessage({
        origin: CMB_CHROME_EXTENSION_ORIGIN,
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        secret: "wrong-secret",
        type: "native-host-hello"
      })
    )

    await expect(response).resolves.toMatchObject({
      connected: false,
      error: "Native host authentication failed",
      type: "host-status"
    })
  })

  it("authenticates a native host and completes a chunked cookie export", async () => {
    const pipePath = join(tmpdir(), `cmb-cookie-bridge-test-${randomUUID()}.sock`)
    const secret = "test-secret"
    const server = new BrowserCookieBridgeServer(pipePath, secret)
    servers.push(server)
    await server.start()

    const socket = connect(pipePath)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.write(
      encodeNativeMessage({
        origin: CMB_CHROME_EXTENSION_ORIGIN,
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        secret,
        type: "native-host-hello"
      })
    )
    socket.write(
      encodeNativeMessage({
        extensionVersion: "0.1.0",
        profileInstanceId: "profile-test",
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        type: "extension-ready"
      })
    )

    await vi.waitFor(() => expect(server.connected).toBe(true))
    const decoder = new NativeMessageDecoder()
    const exportPromise = server.exportCookies(2_000)
    const request = await waitForMessage(socket, decoder)
    expect(request.type).toBe("export-cookies")
    const requestId = String(request.requestId)

    socket.write(
      encodeNativeMessage({ type: "cookie-export-begin", requestId, skipped: 2, total: 1 })
    )
    socket.write(
      encodeNativeMessage({
        type: "cookie-export-chunk",
        requestId,
        index: 0,
        cookies: [
          {
            domain: ".example.com",
            httpOnly: true,
            name: "sid",
            path: "/",
            secure: true,
            value: "secret"
          }
        ]
      })
    )
    socket.write(
      encodeNativeMessage({ type: "cookie-export-complete", requestId, skipped: 2, total: 1 })
    )

    await expect(exportPromise).resolves.toEqual({
      cookies: [
        {
          domain: ".example.com",
          httpOnly: true,
          name: "sid",
          path: "/",
          secure: true,
          value: "secret"
        }
      ],
      skippedCookies: 2
    })
  })

  it("settles a timed-out export even when sending cancellation fails", async () => {
    const pipePath = join(tmpdir(), `cmb-cookie-bridge-test-${randomUUID()}.sock`)
    const secret = "test-secret"
    const server = new BrowserCookieBridgeServer(pipePath, secret)
    servers.push(server)
    await server.start()

    const socket = connect(pipePath)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.write(
      encodeNativeMessage({
        origin: CMB_CHROME_EXTENSION_ORIGIN,
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        secret,
        type: "native-host-hello"
      })
    )
    socket.write(
      encodeNativeMessage({
        extensionVersion: "0.1.0",
        profileInstanceId: "profile-test",
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        type: "extension-ready"
      })
    )
    await vi.waitFor(() => expect(server.connected).toBe(true))

    const writableServer = server as unknown as {
      write(client: unknown, message: unknown): void
    }
    const originalWrite = writableServer.write.bind(server)
    vi.spyOn(writableServer, "write").mockImplementation((client, message) => {
      if ((message as { type?: unknown }).type === "cancel-cookie-export") {
        throw new Error("simulated cancellation write failure")
      }
      originalWrite(client, message)
    })

    const exportPromise = server.exportCookies(10)
    await expect(exportPromise).rejects.toMatchObject({ code: "import_timeout" })
    await expect(server.exportCookies(10)).rejects.toMatchObject({ code: "import_timeout" })
  })
})
