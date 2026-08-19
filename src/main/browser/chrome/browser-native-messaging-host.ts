import { connect, type Socket } from "net"
import {
  CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
  CMB_CHROME_EXTENSION_ORIGIN,
  type CmbChromeExtensionReadyMessage,
  type CmbHostStatusMessage,
  type CmbNativeHostHelloMessage
} from "../../../shared/browser-cookie-bridge"
import {
  getBrowserCookieBridgePipePath,
  getBrowserCookieBridgeSecret
} from "./browser-cookie-bridge-paths"
import { encodeNativeMessage, NativeMessageDecoder } from "./native-messaging-framing"
import { writeBrowserNativeHostLog } from "./browser-native-host-log"

export const CMB_BROWSER_NATIVE_HOST_FLAG = "--cmb-browser-native-host"

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getNativeMessagingOrigin(args: string[] = process.argv): string | null {
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

function log(message: string): void {
  writeBrowserNativeHostLog(message)
}

export async function runBrowserNativeMessagingHost(): Promise<void> {
  const origin = getNativeMessagingOrigin()
  if (!origin) throw new Error("Native messaging host was launched by an unknown extension")

  log(`started, origin=${origin}, pid=${process.pid}, execPath=${process.execPath}`)

  process.stdout.once("error", (error: NodeJS.ErrnoException) => {
    log(`stdout error: code=${error.code}, message=${error.message}`)
    process.exit(error.code === "EPIPE" ? 0 : 1)
  })

  const chromeDecoder = new NativeMessageDecoder()
  let mainSocket: Socket | null = null
  let mainConnected = false
  let mainDecoder = new NativeMessageDecoder()
  let lastReadyMessage: CmbChromeExtensionReadyMessage | null = null
  let closed = false

  const statusMessage = (connected: boolean, error?: unknown): CmbHostStatusMessage => ({
    connected,
    ...(error instanceof Error && error.message ? { error: error.message.slice(0, 500) } : {}),
    protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
    type: "host-status"
  })

  const connectToMain = (): void => {
    if (closed) return
    if (mainSocket) {
      log("connectToMain skipped, already connecting")
      return
    }
    log(`connecting to ${getBrowserCookieBridgePipePath()}`)
    const socket = connect(getBrowserCookieBridgePipePath())
    mainSocket = socket
    mainDecoder = new NativeMessageDecoder()

    socket.once("connect", () => {
      mainConnected = true
      log("socket connected, sending hello")
      const hello: CmbNativeHostHelloMessage = {
        origin,
        protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
        secret: getBrowserCookieBridgeSecret(),
        type: "native-host-hello"
      }
      socket.write(encodeNativeMessage(hello))
      if (lastReadyMessage) {
        log("replaying cached extension-ready message")
        socket.write(encodeNativeMessage(lastReadyMessage))
      }
      writeChromeMessage(statusMessage(true))
    })

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of mainDecoder.push(chunk)) writeChromeMessage(message)
      } catch (error) {
        log(`invalid message from app: ${error instanceof Error ? error.message : String(error)}`)
        socket.destroy()
      }
    })

    const disconnect = (error?: Error): void => {
      if (mainSocket !== socket) return
      mainConnected = false
      mainSocket = null
      const reason = error ? `${error.message}` : "socket closed"
      log(`disconnected: ${reason}, exiting`)
      writeChromeMessage(statusMessage(false, error))
      process.exit(0)
    }
    socket.once("error", (error: Error) => disconnect(error))
    socket.once("close", () => disconnect())
  }

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of chromeDecoder.push(chunk)) {
        const record = recordValue(message)
        if (record.type === "extension-ready") {
          log(
            `extension-ready received, version=${record.extensionVersion}, mainSocket=${mainSocket !== null}, mainConnected=${mainConnected}`
          )
          lastReadyMessage = message as CmbChromeExtensionReadyMessage
        }
        if (mainSocket && mainConnected && !mainSocket.destroyed) {
          mainSocket.write(encodeNativeMessage(message))
        } else {
          log(
            `Chrome message received but socket not connected, type=${record.type ?? "(unknown)"}, mainSocket=${mainSocket !== null}, mainConnected=${mainConnected}, exiting`
          )
          process.exit(0)
        }
      }
    } catch (error) {
      log(`invalid extension message: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      process.stdin.destroy()
    }
  })

  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => {
      log("stdin ended (Chrome disconnected), cleaning up")
      closed = true
      mainSocket?.destroy()
      resolve()
    })
    process.stdin.once("error", (error) => {
      log(`stdin error: ${error instanceof Error ? error.message : String(error)}, cleaning up`)
      closed = true
      mainSocket?.destroy()
      resolve()
    })
    process.stdin.resume()
    log("attempting initial connection to main app")
    connectToMain()
  })
  log("exited")
}
