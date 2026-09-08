import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getHarnessStoreQueueSizeForTests,
  HarnessStoreLimitError,
  readHarnessJsonFileBounded,
  withHarnessStoreMutation,
  writeHarnessJsonFileAtomic
} from "./async-json-store"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-async-store-"))
  directories.push(directory)
  return join(directory, "store.json")
}

describe("Harness async JSON store", () => {
  it("rejects a giant file from asynchronous metadata without allocating or parsing it", async () => {
    const path = await makeStorePath()
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x20))
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await expect(readHarnessJsonFileBounded(path, 1024, "pressure store")).rejects.toBeInstanceOf(
        HarnessStoreLimitError
      )
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it("keeps the caller loop responsive while parsing a near-limit valid store", async () => {
    const path = await makeStorePath()
    const value = "x".repeat(2 * 1024 * 1024)
    await writeFile(path, JSON.stringify({ value }))
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await expect(
        readHarnessJsonFileBounded(path, 4 * 1024 * 1024, "near-limit store")
      ).resolves.toMatchObject({ value })
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it("serializes and atomically writes a near-limit store outside the caller loop", async () => {
    const path = await makeStorePath()
    const value = "x".repeat(2 * 1024 * 1024)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await writeHarnessJsonFileAtomic(path, { value }, 4 * 1024 * 1024, "near-limit write")
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
    expect((JSON.parse(await readFile(path, "utf8")) as { value: string }).value).toHaveLength(
      value.length
    )

    await expect(
      writeHarnessJsonFileAtomic(path, { value }, 1024, "over-limit write")
    ).rejects.toBeInstanceOf(HarnessStoreLimitError)
  })

  it("serializes concurrent read-modify-write operations without losing updates", async () => {
    const path = await makeStorePath()
    await writeHarnessJsonFileAtomic(path, { count: 0 }, 64 * 1024, "counter store")
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await Promise.all(
        Array.from({ length: 64 }, () =>
          withHarnessStoreMutation(path, async () => {
            const current = (await readHarnessJsonFileBounded(
              path,
              64 * 1024,
              "counter store"
            )) as { count: number }
            await new Promise((resolve) => setTimeout(resolve, 1))
            await writeHarnessJsonFileAtomic(
              path,
              { count: current.count + 1 },
              64 * 1024,
              "counter store"
            )
          })
        )
      )
    } finally {
      clearInterval(ticker)
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 64 })
    expect(ticks).toBeGreaterThan(0)
    expect(getHarnessStoreQueueSizeForTests()).toBe(0)
  })
})
