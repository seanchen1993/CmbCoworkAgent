import { connect, type Socket } from "net"
import {
  CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
  CMB_CHROME_EXTENSION_ORIGIN,
  type CmbChromeExtensionReadyMessage,
  type CmbHostStatusMessage,
  type CmbNativeHostHelloMessage
} from "../../shared/browser-cookie-bridge"
import {
  getBrowserCookieBridgePipePath,
  getBrowserCookieBridgeSecret
} from "./browser-cookie-bridge-paths"
import { encodeNativeMessage, NativeMessageDecoder } from "./native-messaging-framing"

const RECONNECT_DELAY_MS = 2_000
export const CMB_BROWSER_NATIVE_HOST_FLAG = "--cmb-browser-native-host"

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function getNativeMessagingOrigin(args: string[] = process.argv): string | null {
  const origin = args.find((value) => value.startsWith("chrome-extension://"))
  return origin === CMB_CHROME_EXTENSION_ORIGIN ? origin : null
}

export function isBrowserNativeMessagingHostLaunch(args: string[] = process.argv): boolean {
  // Older registrations launched the Electron executable directly and only supplied the
  // Chrome origin. Keep accepting those launches while upgrades replace the manifest.
  return getNativeMessagingOrigin(args) !== null
}

export function isDedicatedBrowserNativeMessagingHostLaunch(
  args: string[] = process.argv
): boolean {
  return args.includes(CMB_BROWSER_NATIVE_HOST_FLAG) && getNativeMessagingOrigin(args) !== null
}

function writeChromeMessage(message: unknown): void {
  process.stdout.write(encodeNativeMessage(message))
}

export async function runBrowserNativeMessagingHost(): Promise<void> {
  const origin = getNativeMessagingOrigin()
  if (!origin) throw new Error("Native messaging host was launched by an unknown extension")

  process.stdout.once("error", (error: NodeJS.ErrnoException) => {
    process.exit(error.code === "EPIPE" ? 0 : 1)
  })

  const chromeDecoder = new NativeMessageDecoder()
  let mainSocket: Socket | null = null
  let mainConnected = false
  let mainDecoder = new NativeMessageDecoder()
  let lastReadyMessage: CmbChromeExtensionReadyMessage | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let closed = false

  const statusMessage = (connected: boolean, error?: unknown): CmbHostStatusMessage => ({
    connected,
    ...(error instanceof Error && error.message ? { error: error.message.slice(0, 500) } : {}),
    protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
    type: "host-status"
  })

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectToMain()
    }, RECONNECT_DELAY_MS)
  }

  const connectToMain = (): void => {
    if (closed || mainSocket) return
    const socket = connect(getBrowserCookieBridgePipePath())
    mainSocket = socket
    mainDecoder = new NativeMessageDecoder()

    socket.once("connect", () => {
      mainConnected = true
      const hello: CmbNativeHostHelloMessage = {
        origin,
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        secret: getBrowserCookieBridgeSecret(),
        type: "native-host-hello"
      }
      socket.write(encodeNativeMessage(hello))
      if (lastReadyMessage) socket.write(encodeNativeMessage(lastReadyMessage))
      writeChromeMessage(statusMessage(true))
    })

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of mainDecoder.push(chunk)) writeChromeMessage(message)
      } catch (error) {
        process.stderr.write(
          `[CmbBrowserNativeHost] Invalid message from app: ${error instanceof Error ? error.message : String(error)}\n`
        )
        socket.destroy()
      }
    })

    const disconnect = (error?: Error): void => {
      if (mainSocket !== socket) return
      mainConnected = false
      mainSocket = null
      writeChromeMessage(statusMessage(false, error))
      scheduleReconnect()
    }
    socket.once("error", (error: Error) => disconnect(error))
    socket.once("close", () => disconnect())
  }

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of chromeDecoder.push(chunk)) {
        const record = recordValue(message)
        if (record.type === "extension-ready") {
          lastReadyMessage = message as CmbChromeExtensionReadyMessage
        }
        if (mainSocket && mainConnected && !mainSocket.destroyed) {
          mainSocket.write(encodeNativeMessage(message))
        } else if (!mainSocket || mainSocket.destroyed) {
          connectToMain()
        }
      }
    } catch (error) {
      process.stderr.write(
        `[CmbBrowserNativeHost] Invalid extension message: ${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exitCode = 1
      process.stdin.destroy()
    }
  })

  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      mainSocket?.destroy()
      resolve()
    })
    process.stdin.once("error", () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      mainSocket?.destroy()
      resolve()
    })
    process.stdin.resume()
    connectToMain()
  })
}
