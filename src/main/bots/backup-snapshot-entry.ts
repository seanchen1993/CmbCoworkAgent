import { createScheduledBotSnapshot } from "./backups"
import { readPrivateJson } from "./backup-io"
import { botSnapshotRequest } from "./backup-snapshot-contract"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { BotHostLock } from "./host-lock"

if (!process.send) throw new Error("Snapshot worker requires a parent IPC channel")
process.once("disconnect", () => process.exit(1))
process.once("message", async (raw: unknown) => {
  let nonce: string | undefined
  try {
    const input = botSnapshotRequest.parse(raw)
    nonce = input.nonce
    const ownership = BotHostLock.observe(input.directory),
      descriptor = await readPrivateJson(input.directory, "host.json", 16_384),
      owner = z
        .object({ pid: z.number().int().positive(), hostId: z.string().uuid() })
        .parse(descriptor.value)
    if (owner.pid !== process.ppid || owner.hostId !== input.hostId)
      throw new Error("备份所属后台已变化")
    const guard = async () => {
      await ownership.checkCurrent()
      if (
        !process.connected ||
        (await readPrivateJson(input.directory, "host.json", 16_384)).sha256 !== descriptor.sha256
      )
        throw new Error("备份所属后台已变化")
      ownership.assertCurrent()
    }
    const result = await createScheduledBotSnapshot(input.directory, input.nonce, undefined, guard)
    process.send?.({ result }, () => process.exit(0))
  } catch (error) {
    if (nonce && error instanceof BotDomainError && error.code === "snapshot_deleted") {
      process.send?.({ result: { status: "deleted", id: nonce } }, () => process.exit(0))
      return
    }
    process.send?.({ error: error instanceof Error ? error.message : "定时备份失败" }, () =>
      process.exit(1)
    )
  }
})
