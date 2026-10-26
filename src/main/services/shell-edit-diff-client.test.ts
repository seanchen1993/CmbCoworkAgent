import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import * as iconv from "iconv-lite"
import { describe, expect, it, vi } from "vitest"
import { ShellEditDiffClient } from "./shell-edit-diff-client"
import { shellEditLineFragments } from "./adoption-lines"

class FakeWorker extends EventEmitter {
  terminated = false
  active = 0
  peak = 0
  constructor(private mode: "ok" | "hang" | "crash" | "error" = "ok") {
    super()
  }
  unref(): void {
    // A fake worker has no native handle to unref.
  }
  ref(): void {
    // A fake worker has no native handle to ref.
  }
  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }
  postMessage(input: { id: number; before: Buffer | string; after: Buffer | string }): void {
    this.active++
    this.peak = Math.max(this.peak, this.active)
    if (this.mode === "hang") return
    setImmediate(() => {
      this.active--
      if (this.mode === "crash") this.emit("error", new Error("test crash"))
      else if (this.mode === "error") this.emit("message", { id: input.id, error: "diff failed" })
      else
        this.emit("message", {
          id: input.id,
          result: shellEditLineFragments(input.before, input.after)
        })
    })
  }
}
const asWorker = (w: FakeWorker): Worker => w as unknown as Worker
const large = "const a = 1\n".repeat(3500)

describe("shell edit diff isolation", () => {
  it("counts only new-only and removed-only nonblank lines", () => {
    expect(shellEditLineFragments("keep\nold\nold\n", "keep\nnew\nold\n\n")).toEqual({
      generatedContent: "new",
      oldString: "old",
      deletedLineCount: 1
    })
    expect(shellEditLineFragments(" const x = 1\n", "const   x = 1\n\n")).toBeNull()
    expect(shellEditLineFragments("removed\n", "")).toEqual({
      generatedContent: "",
      oldString: "removed",
      deletedLineCount: 1
    })
  })

  it("uses the committed-blob decoder for GBK", () => {
    const context = "// 这是一段用于检验文件编码的中文说明，包括实现内容、测试步骤和结果分析。\n"
    const before = iconv.encode(context + "const 说明 = '旧版本';\n", "gbk")
    const after = iconv.encode(context + "const 说明 = '新版本';\n", "gbk")
    expect(shellEditLineFragments(before, after)).toEqual(
      shellEditLineFragments(iconv.decode(before, "gbk"), iconv.decode(after, "gbk"))
    )
  })

  it("does not create a worker for small files", async () => {
    const factory = vi.fn(async () => asWorker(new FakeWorker()))
    const client = new ShellEditDiffClient(factory)
    expect(await client.diff("old", "new")).toEqual(shellEditLineFragments("old", "new"))
    expect(factory).not.toHaveBeenCalled()
    await client.close()
  })

  it("runs queued large diffs sequentially with the same semantics", async () => {
    const worker = new FakeWorker(),
      factory = vi.fn(async () => asWorker(worker))
    const client = new ShellEditDiffClient(factory)
    const result = await Promise.all([
      client.diff(large, large + "A\n"),
      client.diff(large, large + "B\n"),
      client.diff(large, large + "C\n")
    ])
    expect(result.map((x) => x?.generatedContent)).toEqual(["A", "B", "C"])
    expect(worker.peak).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
    await client.close()
    expect(worker.terminated).toBe(true)
  })

  it("bounds fallback after startup failure and retries no sooner than the cooldown", async () => {
    const factory = vi.fn(async (): Promise<Worker> => {
      throw new Error("startup failed")
    })
    const client = new ShellEditDiffClient(factory)
    expect(await client.diff(large, large + "fallback\n")).toEqual(
      shellEditLineFragments(large, large + "fallback\n")
    )
    expect(await client.diff("x".repeat(300_000), "y")).toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it.each(["hang", "crash", "error"] as const)(
    "skips failed work without main-thread fallback and replaces the worker: %s",
    async (mode) => {
      const failed = new FakeWorker(mode),
        replacement = new FakeWorker()
      const factory = vi
        .fn()
        .mockResolvedValueOnce(asWorker(failed))
        .mockResolvedValue(asWorker(replacement))
      const client = new ShellEditDiffClient(factory, 25)
      expect(await client.diff(large, large + "lost\n")).toBeNull()
      expect(failed.terminated).toBe(true)
      expect((await client.diff(large, large + "next\n"))?.generatedContent).toBe("next")
      await client.close()
    }
  )

  it("retires a worker after idle time", async () => {
    const worker = new FakeWorker(),
      client = new ShellEditDiffClient(async () => asWorker(worker), 100, 10)
    await client.diff(large, large + "new\n")
    await vi.waitFor(() => expect(worker.terminated).toBe(true))
    await client.close()
  })

  it("times out a hanging startup and terminates its late worker", async () => {
    let release!: (worker: Worker) => void
    const starting = new Promise<Worker>((resolve) => {
      release = resolve
    })
    const client = new ShellEditDiffClient(() => starting, 20)
    expect((await client.diff(large, large + "fallback\n"))?.generatedContent).toBe("fallback")
    const late = new FakeWorker()
    release(asWorker(late))
    await vi.waitFor(() => expect(late.terminated).toBe(true))
    await client.close()
  })

  it("handles a crash between requests without an unhandled error", async () => {
    const first = new FakeWorker(),
      second = new FakeWorker()
    const factory = vi
      .fn()
      .mockResolvedValueOnce(asWorker(first))
      .mockResolvedValue(asWorker(second))
    const client = new ShellEditDiffClient(factory)
    await client.diff(large, large + "first\n")
    first.emit("error", new Error("idle crash"))
    expect((await client.diff(large, large + "second\n"))?.generatedContent).toBe("second")
    expect(first.terminated).toBe(true)
    await client.close()
  })

  it("rejects oversized files before starting workers", async () => {
    const factory = vi.fn(async () => asWorker(new FakeWorker())),
      client = new ShellEditDiffClient(factory)
    expect(await client.diff("", "x".repeat(2 * 1024 * 1024 + 1))).toBeNull()
    expect(factory).not.toHaveBeenCalled()
    await client.close()
  })
})
