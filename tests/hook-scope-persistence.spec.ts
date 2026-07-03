/**
 * Regression tests for persistent hook-scope restoration.
 *
 * Run:
 *   npx tsx tests/hook-scope-persistence.spec.ts
 */

import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), "cmb-hook-scope-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
}

async function testPersistentHookKeysSurviveDatabaseReopen(): Promise<void> {
  await withTempHome(async () => {
    const db = await import("../src/main/db/index.ts")
    const { filterScopedHooks } = await import("../src/main/hooks/scope.ts")
    const { createPersistentThreadHookScope, readPersistentHookKeysFromMetadata } =
      await import("../src/main/hooks/thread-scope-persistence.ts")

    const threadId = "thread-hook-scope-restart"
    const persistentHook = {
      id: "persisted-after-restart",
      event: "PreToolUse",
      matcher: "write_file",
      command: "echo persistent",
      enabled: true,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      persistAfterInterrupt: true,
      skillName: "persistent-skill",
      skillPath: "C:/skills/persistent-skill",
      hookSourceType: "skill",
      hookSourceRoot: "C:/skills/persistent-skill",
      hookSourcePath: "C:/skills/persistent-skill/hooks/hooks.json"
    } as const

    await db.initializeDatabase()
    db.createThread(threadId, { title: "Hook scope restart regression" })

    const liveScope = createPersistentThreadHookScope(threadId)
    liveScope.activatePersistentHooks([persistentHook])

    const stored = db.getThread(threadId)
    const metadata = JSON.parse(stored?.metadata ?? "{}") as Record<string, unknown>
    assert(
      readPersistentHookKeysFromMetadata(metadata).length === 1,
      "persistent hook key should be written to thread metadata"
    )

    await db.flush()
    await db.closeDatabase()

    await db.initializeDatabase()
    const restoredScope = createPersistentThreadHookScope(threadId)
    const result = filterScopedHooks(
      { baseHooks: [], pluginHooks: [], skillHooks: [persistentHook] },
      { toolName: "write_file" },
      restoredScope,
      undefined,
      "PreToolUse"
    )

    assert(result.length === 1, `expected restored persistent hook, got ${result.length}`)
    assert(
      result[0].id === "persisted-after-restart",
      `expected persisted hook id, got ${result[0]?.id ?? "none"}`
    )
    await db.closeDatabase()
  })
}

async function testPersistentHookKeyWritesMergeWithExistingMetadata(): Promise<void> {
  await withTempHome(async () => {
    const db = await import("../src/main/db/index.ts")
    const { readPersistentHookKeysFromMetadata, persistPersistentHookKeysForThread } =
      await import("../src/main/hooks/thread-scope-persistence.ts")

    const threadId = "thread-hook-scope-merge"
    await db.initializeDatabase()
    db.createThread(threadId, {
      title: "Hook scope merge regression",
      hookScope: { persistentHookKeys: ["existing-key"] }
    })

    persistPersistentHookKeysForThread(threadId, ["new-key"])

    const stored = db.getThread(threadId)
    const metadata = JSON.parse(stored?.metadata ?? "{}") as Record<string, unknown>
    const keys = readPersistentHookKeysFromMetadata(metadata)

    assert(keys.includes("existing-key"), "existing persistent hook key should be preserved")
    assert(keys.includes("new-key"), "new persistent hook key should be stored")
    assert(keys.length === 2, `expected exactly two persistent keys, got ${keys.join(",")}`)

    await db.closeDatabase()
  })
}

async function run(): Promise<void> {
  await testPersistentHookKeysSurviveDatabaseReopen()
  console.log("PASS hook scope persistent keys survive database reopen")
  await testPersistentHookKeyWritesMergeWithExistingMetadata()
  console.log("PASS hook scope persistent key writes merge with metadata")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
