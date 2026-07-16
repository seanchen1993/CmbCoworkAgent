import { EventEmitter } from "events"
import { randomUUID } from "crypto"
import { createConnection, type Socket } from "net"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getOfficialBrowserUsePipeBasePath } from "../../../browser/browser-platform"
import {
  createBrowserRuntimeNodeReplHost,
  type BrowserRuntimeNodeReplHost
} from "./browser-runtime-host"

vi.mock("net", () => ({
  createConnection: vi.fn(() => {
    const socket = new EventEmitter() as Socket
    socket.write = vi.fn(() => true) as unknown as Socket["write"]
    socket.end = vi.fn() as unknown as Socket["end"]
    socket.destroy = vi.fn() as unknown as Socket["destroy"]
    queueMicrotask(() => socket.emit("connect"))
    return socket
  })
}))

interface NativePipeGlobals {
  nodeRepl: {
    nativePipe: {
      createConnection(pipePath: string): Promise<Socket>
    }
  }
}

let hosts: BrowserRuntimeNodeReplHost[] = []

function externalPipePath(): string {
  const id = randomUUID()
  const basePath = getOfficialBrowserUsePipeBasePath()
  if (process.platform === "win32") return `${basePath}-test-${id}`
  return join(basePath, `test-${id}.sock`)
}

function nonOfficialPipePath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\cmb-not-browser-${randomUUID()}`
  return join("/tmp", `cmb-not-browser-${randomUUID()}.sock`)
}

function createHost(threadId: string): BrowserRuntimeNodeReplHost {
  const host = createBrowserRuntimeNodeReplHost({
    workspacePath: process.cwd(),
    threadId
  })
  hosts.push(host)
  return host
}

describe("browser runtime host native pipe", () => {
  afterEach(() => {
    for (const host of hosts) host.dispose()
    hosts = []
    vi.clearAllMocks()
  })

  it("connects external Browser namespace pipes for Chrome extension backends", async () => {
    const pipePath = externalPipePath()
    const host = createHost("external-pipe")
    const globals = host.globals as unknown as NativePipeGlobals

    const socket = await globals.nodeRepl.nativePipe.createConnection(pipePath)

    expect(createConnection).toHaveBeenCalledWith(pipePath)
    expect(socket.write("ping")).toBe(true)
  })

  it("rejects native pipes outside the official Browser namespace", async () => {
    const host = createHost("external-pipe-reject")
    const globals = host.globals as unknown as NativePipeGlobals

    await expect(
      globals.nodeRepl.nativePipe.createConnection(nonOfficialPipePath())
    ).rejects.toThrow("outside the official Browser namespace")
    expect(createConnection).not.toHaveBeenCalled()
  })
})
