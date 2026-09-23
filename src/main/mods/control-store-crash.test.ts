import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { ModControlStore } from "./control-store"

it("recovers durable capture after physical process termination without replay or a false PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-crash-"))
  const database = join(root, "control.sqlite")
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("tests/support/mods-evidence-crash-entry.ts"), database],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  )
  const closed = once(child, "close")
  let store: ModControlStore | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ""
      child.stdout.on("data", (chunk) => {
        output += String(chunk)
        if (output.includes("CAPTURE_DURABLE")) resolve()
      })
      child.on("error", reject)
      child.on("exit", (code) => reject(Error(`capture child exited before ready: ${code}`)))
      timeout = setTimeout(() => reject(Error("capture child readiness timed out")), 10000)
    })
    child.kill("SIGKILL")
    await closed
    store = new ModControlStore(database)
    const rows = store.completionEvidence("project", "thread")
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.id === "pending")).toMatchObject({
      phase: "capture.started",
      status: "interrupted",
      binding: null,
      detail: { attempt: "pending", error: "MODS_PROCESS_RESTARTED" }
    })
    expect(rows.find((row) => row.id === "settled")).toMatchObject({
      phase: "capture.started",
      status: "completed",
      binding: null,
      detail: { attempt: "settled", settledBy: "error" }
    })
    expect(rows.some((row) => row.status === "pass" || row.status === "running")).toBe(false)
  } finally {
    if (timeout) clearTimeout(timeout)
    child.kill("SIGKILL")
    await closed.catch(() => {})
    store?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
