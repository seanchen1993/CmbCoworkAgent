import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MemoryGitRootResolver, type MemoryGitRunner } from "./git-root-resolver"

const tempDirs: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-git-root-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("MemoryGitRootResolver", () => {
  it("deduplicates in-flight work without letting one consumer cancel another", async () => {
    const directory = makeDirectory()
    let calls = 0
    const runnerState: { signal?: AbortSignal } = {}
    const runner: MemoryGitRunner = async (_cwd, _args, signal) => {
      calls += 1
      runnerState.signal = signal
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      return join(directory, ".git")
    }
    const resolver = new MemoryGitRootResolver(runner)
    const firstController = new AbortController()
    const first = resolver.find(directory, firstController.signal).catch((error) => error)
    const second = resolver.find(directory)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    firstController.abort()

    await expect(first).resolves.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toBe(directory)
    expect(calls).toBe(1)
    expect(runnerState.signal?.aborted).toBe(false)
  })

  it("kills orphaned slow work and lets the replacement request start immediately", async () => {
    const directory = makeDirectory()
    let calls = 0
    const runner: MemoryGitRunner = (_cwd, _args, signal) => {
      calls += 1
      const call = calls
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(join(directory, ".git")), call === 1 ? 5_000 : 10)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          },
          { once: true }
        )
      })
    }
    const resolver = new MemoryGitRootResolver(runner)
    const controller = new AbortController()
    const superseded = resolver.find(directory, controller.signal).catch((error) => error)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const latest = resolver.find(directory)

    await expect(superseded).resolves.toMatchObject({ name: "AbortError" })
    await expect(latest).resolves.toBe(directory)
    expect(calls).toBe(2)
    expect(resolver.activeCount()).toBe(0)
  })

  it("does not block the main event loop while Git is slow", async () => {
    const directory = makeDirectory()
    const runner: MemoryGitRunner = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      return join(directory, ".git")
    }
    const resolver = new MemoryGitRootResolver(runner)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    await resolver.find(directory)
    clearInterval(ticker)
    expect(ticks).toBeGreaterThan(0)
  })
})
