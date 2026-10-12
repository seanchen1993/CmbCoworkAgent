import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DesktopArtifactDownloads } from "../../src/main/bots/desktop-artifact-downloads"
import { DesktopArtifactDownloadLedger } from "../../src/main/bots/desktop-artifact-download-ledger"
import { BOT_FILE_CHUNK_BYTES } from "../../src/shared/bot-files"
async function main() {
  const [root, nonce, point] = process.argv.slice(2)
  if (!root || !nonce || !point) throw new Error("fixture arguments")
  const bytes = await readFile(join(root, "fixture-source")),
    source = {
      artifactId: "artifact",
      conversationId: "conversation",
      dataEpoch: "epoch-1",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    },
    artifact = {
      id: source.artifactId,
      conversationId: source.conversationId,
      runId: null,
      name: "result.txt",
      mime: "text/plain",
      size: source.size,
      sha256: source.sha256,
      createdAt: Date.now()
    }
  const original = DesktopArtifactDownloadLedger.prototype.put
  DesktopArtifactDownloadLedger.prototype.put = function (record, revision) {
    const checkpoint = record.job.state === "downloading" && record.job.bytes > 0
    if (
      (point === "before-offset" && checkpoint) ||
      (point === "after-publish" && record.job.state === "completed")
    )
      process.kill(process.pid, "SIGKILL")
    original.call(this, record, revision)
    if (point === "after-offset" && checkpoint) process.kill(process.pid, "SIGKILL")
  }
  const manager = new DesktopArtifactDownloads(join(root, "ledger", "downloads.sqlite"), {
    source: {
      release: async () => undefined,
      describe: async () => ({ dataEpoch: source.dataEpoch, artifact }),
      read: async (_source, offset) => ({
        dataEpoch: source.dataEpoch,
        chunk: {
          artifact,
          offset,
          base64: bytes.subarray(offset, offset + BOT_FILE_CHUNK_BYTES).toString("base64")
        }
      })
    },
    choose: async () => join(root, "result.txt"),
    reveal: async () => undefined,
    assertOwnership: () => undefined,
    withPublication: async (_source, _signal, operation) => operation()
  })
  await manager.start({ nonce, source })
  setTimeout(() => {
    console.error("fault did not fire")
    process.exit(2)
  }, 5000)
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
