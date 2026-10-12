import { randomBytes, randomUUID, createHash } from "node:crypto"
import { mkdir, open, unlink } from "node:fs/promises"
import { join } from "node:path"
import { BotStore } from "../../src/main/bots/store"
import { BotArtifacts } from "../../src/main/bots/artifacts"
import { BotHost } from "../../src/main/bots/host"
import { BotRpcServer } from "../../src/main/bots/rpc"
import type { BotArtifact } from "../../src/shared/bot-types"
import { BOT_FILE_CHUNK_BYTES } from "../../src/shared/bot-files"

async function main() {
  const root = process.argv[2]
  if (!root || !process.send) throw new Error("Expected isolated fixture root and IPC")
  const store = new BotStore(join(root, "bots.sqlite"))
  const directory = join(root, "objects")
  const files = new BotArtifacts(directory, store)
  const host = new BotHost(store, undefined, 4, undefined, files)
  const server = new BotRpcServer(host, randomBytes(32).toString("hex"))
  const token: unknown = Reflect.get(server, "token")
  if (typeof token !== "string") throw new Error("Missing fixture transport token")
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-download-${randomUUID()}`
      : join(root, "host.sock")
  await files.recover()
  await server.listen(socketPath)
  let peakRSS = process.memoryUsage().rss
  let flipEpoch = false
  let held: Promise<void> | undefined
  let releaseHeld: (() => void) | undefined
  let heldRequests = 0
  const chunk = files.chunk.bind(files)
  files.chunk = async (input) => {
    if (held && input.offset < store.getArtifact(input.id).size) {
      heldRequests++
      await held
    }
    const result = await chunk(input)
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss)
    if (flipEpoch) {
      flipEpoch = false
      store.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
        [randomUUID(), Date.now()]
      )
    }
    return result
  }
  let shutdown: Promise<void> | undefined
  const finish = () =>
    (shutdown ??= (async () => {
      releaseHeld?.()
      await server.close()
      await host.stop()
      await files.close()
      store.close()
      if (process.connected) process.disconnect?.()
    })())
  process.once("disconnect", () => {
    void finish().catch(() => {
      process.exitCode = 1
    })
  })
  process.send({
    type: "ready",
    descriptor: { version: 1, pid: process.pid, hostId: host.id, socketPath, token }
  })
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("id" in message) || !("op" in message)) return
    const id = message.id
    if (typeof id !== "string" || typeof message.op !== "string") return
    void (async () => {
      switch (message.op) {
        case "seed": {
          if (
            !("size" in message) ||
            typeof message.size !== "number" ||
            !Number.isSafeInteger(message.size) ||
            message.size < 1 ||
            message.size > 200 * 1024 ** 2
          )
            throw new Error("Invalid fixture byte count")
          const size = message.size
          const { conversationId } = store.createBot({
            nonce: randomUUID(),
            name: "Native file Host"
          })
          const artifacts: BotArtifact[] = []
          await mkdir(directory, { recursive: true })
          for (const name of ["a.mp4", "b.mp4"]) {
            const source = join(directory, `seed-${randomUUID()}`)
            const handle = await open(source, "wx", 0o600)
            const block = Buffer.alloc(BOT_FILE_CHUNK_BYTES, 23)
            block.write("ftyp", 4, "ascii")
            const hash = createHash("sha256")
            try {
              for (let offset = 0; offset < size; offset += block.length) {
                const bytes = block.subarray(0, Math.min(block.length, size - offset))
                await handle.writeFile(bytes)
                hash.update(bytes)
              }
              await handle.sync()
            } finally {
              await handle.close()
            }
            try {
              artifacts.push(
                await files.publishFromFile(
                  { id: randomUUID(), conversationId, runId: null, name, mime: "video/mp4" },
                  source,
                  size,
                  hash.digest("hex")
                )
              )
            } finally {
              await unlink(source)
            }
          }
          return { artifacts, dataEpoch: store.dataEpoch() }
        }
        case "flip-after-chunk":
          flipEpoch = true
          return null
        case "hold":
          held = new Promise<void>((resolve) => {
            releaseHeld = resolve
          })
          heldRequests = 0
          return null
        case "release":
          releaseHeld?.()
          held = undefined
          return null
        case "metrics": {
          const sockets: unknown = Reflect.get(server, "sockets")
          return {
            sockets: sockets instanceof Set ? sockets.size : -1,
            heldRequests,
            rss: process.memoryUsage().rss,
            peakRSS,
            resources: process.getActiveResourcesInfo()
          }
        }
        case "close":
          await finish()
          return null
        default:
          throw new Error("Unknown fixture command")
      }
    })().then(
      (value) => {
        if (process.connected) process.send?.({ id, ok: true, value })
      },
      (error: unknown) => {
        if (process.connected)
          process.send?.({
            id,
            ok: false,
            error: error instanceof Error ? error.message : "Fixture failed"
          })
      }
    )
  })
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
