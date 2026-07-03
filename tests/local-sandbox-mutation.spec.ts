/**
 * Regression tests for LocalSandbox mutation callbacks.
 *
 * Run:
 *   npx tsx tests/local-sandbox-mutation.spec.ts
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import type { AgentFileMutationKind } from "../src/main/services/agent-auto-commit.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testFailedEditDoesNotRecordMutation(): Promise<void> {
  await withTempDir("local-sandbox-edit-failure", async (dir) => {
    const file = join(dir, "target.txt")
    await writeFile(file, "alpha\nbeta\n", "utf8")
    const mutations: Array<{ filePath: string; kind: AgentFileMutationKind }> = []
    const sandbox = new LocalSandbox({
      rootDir: dir,
      onFileMutation: (filePath, kind) => mutations.push({ filePath, kind })
    })

    const result = await sandbox.edit(file, "missing text", "replacement")

    assert(result.error, `edit should fail when oldString is missing: ${JSON.stringify(result)}`)
    assert(mutations.length === 0, "failed edit must not record a file mutation")
  })
}

async function testSuccessfulEditRecordsMutation(): Promise<void> {
  await withTempDir("local-sandbox-edit-success", async (dir) => {
    const file = join(dir, "target.txt")
    await writeFile(file, "alpha\nbeta\n", "utf8")
    const mutations: Array<{ filePath: string; kind: AgentFileMutationKind }> = []
    const sandbox = new LocalSandbox({
      rootDir: dir,
      onFileMutation: (filePath, kind) => mutations.push({ filePath, kind })
    })

    const result = await sandbox.edit(file, "beta", "gamma")

    assert(!result.error, `edit should succeed: ${JSON.stringify(result)}`)
    assert(
      mutations.length === 1,
      `successful edit should record one mutation, got ${mutations.length}`
    )
    assert(mutations[0]?.filePath === file, "mutation should reference the edited file")
    assert(mutations[0]?.kind === "edit", "mutation kind should be edit")
  })
}

async function run(): Promise<void> {
  await testFailedEditDoesNotRecordMutation()
  console.log("PASS failed edit does not record mutation")
  await testSuccessfulEditRecordsMutation()
  console.log("PASS successful edit records mutation")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
