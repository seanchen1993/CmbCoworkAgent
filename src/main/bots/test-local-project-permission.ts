import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, relative } from "node:path"
import type { BotStore } from "./store"
import { BotHostLock } from "./host-lock"
import { createBotLocalToolAuthority } from "./local-tool-authority"
import { lstat, realpath } from "node:fs/promises"
import type { BotInteraction, BotWorkspaceSnapshot } from "../../shared/bot-types"
import { botLocalToolCard, type BotLocalToolAnswer } from "../../shared/bot-local-tool-permission"

const projectReadTarget = "本项目的说明、配置和文件（含目录检索）"
interface LocalProjectPort {
  snapshot(): Promise<BotWorkspaceSnapshot>
  resolve(input: BotLocalToolAnswer): Promise<BotInteraction>
}

/** Test-only admission for a named temporary project/run. Original action
 * approvals and every other interaction remain under the caller's control. */
export async function createTestLocalProjectAccess(input: {
  workspace: string
  runId: string
  readProject: boolean
  commands?: readonly string[]
  writePaths?: readonly string[]
}) {
  const root = await realpath(input.workspace),
    info = await lstat(root, { bigint: true }),
    commands = new Set(input.commands ?? []),
    writePaths = new Set(input.writePaths ?? [])
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Fixture project must be a canonical directory")
  let scope: { targetId: string; dataEpoch: string } | undefined
  const assertProject = async () => {
    const current = await lstat(root, { bigint: true })
    if (
      (await realpath(input.workspace)) !== root ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      throw new Error("Fixture project identity changed")
  }
  return {
    async snapshot(port: LocalProjectPort): Promise<BotWorkspaceSnapshot> {
      await assertProject()
      const snapshot = await port.snapshot()
      let resolved = false
      for (const item of snapshot.interactions) {
        if (item.runId !== input.runId || item.status !== "pending" || !item.localProjectAccess)
          continue
        // Only authenticated Host metadata is authoritative. A model-authored
        // prompt resembling a permission card is deliberately ignored.
        const card = botLocalToolCard.parse(item.localProjectAccess)
        if (
          card.action.workspace !== root ||
          card.dataEpoch !== snapshot.dataEpoch ||
          (scope && (scope.targetId !== card.target.id || scope.dataEpoch !== card.dataEpoch))
        )
          throw new Error("Fixture local permission scope does not match its project/Host")
        const allowed =
          (input.readProject &&
            card.action.kind === "read-file" &&
            card.action.target === projectReadTarget) ||
          (card.action.kind === "run-command" && commands.has(card.action.target)) ||
          (card.action.kind === "write-file" && writePaths.has(card.action.target))
        if (!allowed)
          throw new Error(
            `Fixture has no explicit admission for ${card.action.kind}: ${card.action.target}`
          )
        scope ??= { targetId: card.target.id, dataEpoch: card.dataEpoch }
        await assertProject()
        const answered = await port.resolve({
          nonce: `fixture-local:${createHash("sha256")
            .update(
              JSON.stringify([
                card.target.id,
                card.dataEpoch,
                item.id,
                item.revision,
                card.action.fingerprint
              ])
            )
            .digest("hex")}`,
          targetId: card.target.id,
          dataEpoch: card.dataEpoch,
          id: item.id,
          revision: item.revision,
          resolution: "allow-once"
        })
        if (
          answered.id !== item.id ||
          answered.runId !== input.runId ||
          answered.status !== "answered" ||
          answered.answer !== "approve" ||
          answered.revision !== item.revision + 1
        )
          throw new Error("Fixture did not receive an exact allow-once acknowledgement")
        resolved = true
      }
      // Observe the Host again instead of hiding approved cards in a local copy.
      return resolved ? port.snapshot() : snapshot
    }
  }
}

/** Pre-authorize only a newly owned temporary installation for in-process Runtime tests.
 * Uses the real physical Host identity; original action approvals and child roles still apply. */
export function bindTestLocalProjectAuthority(store: BotStore, directory: string): () => void {
  const canonical = realpathSync(directory),
    part = relative(realpathSync(tmpdir()), canonical)
  if (
    !part ||
    part === ".." ||
    part.startsWith("../") ||
    part.startsWith("..\\") ||
    isAbsolute(part)
  )
    throw new Error("Fixture authority must belong to a dedicated temporary installation")
  const lock = BotHostLock.acquire(canonical)
  if (!lock) throw new Error("Fixture installation is already owned")
  try {
    store.localTools.bind(createBotLocalToolAuthority(canonical, lock))
    const policy = store.localTools.read()
    store.localTools.change({
      nonce: "fixture-local-project",
      targetId: policy.target.id,
      dataEpoch: policy.dataEpoch,
      revision: policy.revision,
      choice: "always"
    })
    return () => lock.release()
  } catch (error) {
    lock.release()
    throw error
  }
}
