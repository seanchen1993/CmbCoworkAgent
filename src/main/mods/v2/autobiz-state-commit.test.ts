import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { advanceAutobizCheckpoint } from "./autobiz-validation"
import { withPinnedAutobiz } from "./autobiz-source"

const isolated = vi.hoisted(() => ({
  root: "",
  fault: "",
  abort: undefined as (() => void) | undefined
}))
vi.mock("../../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => isolated.root }))
vi.mock("./autobiz-transition-process", async (original) => {
  const actual = await original<typeof import("./autobiz-transition-process")>()
  return {
    runAutobizTransitionProcess: (
      input: Parameters<typeof actual.runAutobizTransitionProcess>[0]
    ) => {
      const args = input.args.map((arg) => {
        if (isolated.fault === "after-ack")
          return arg.replace("acknowledged = True", "acknowledged = True\n        os._exit(71)")
        if (isolated.fault === "partial")
          return arg.replace(
            "for handle,data in zip(state_handles,after):",
            "for handle,data in zip(state_handles,after):\n            if handle == state_handles[1]: os._exit(72)"
          )
        if (isolated.fault === "timeout-after-ack")
          return arg.replace(
            "acknowledged = True",
            "acknowledged = True\n        __import__('time').sleep(10)"
          )
        return arg
      })
      return actual.runAutobizTransitionProcess({
        ...input,
        args,
        written: (message) => {
          input.written?.(message)
          isolated.abort?.()
        }
      })
    }
  }
})
vi.setConfig({ testTimeout: 60_000 })
const roots: string[] = []
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
afterEach(async () => {
  isolated.fault = ""
  isolated.abort = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "mods-state-cas-"))
  roots.push(parent)
  const root = join(parent, "workspace")
  isolated.root = join(parent, "host")
  const directory = join(root, ".autobizdevops")
  const feature = join(directory, "features", "order-export")
  await mkdir(join(feature, "specs"), { recursive: true })
  const state = join(directory, "state.json")
  await writeFile(
    state,
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: {
        "order-export": {
          feature: "order-export",
          checkpoint: "requirements_eval_in_progress",
          workflowProfile: "standard",
          workflowTemplate: "standard",
          workflowDecisions: {}
        }
      }
    })
  )
  for (const name of ["proposal.md", "design.md", "PLAN.md", "specs/orders.md"])
    await writeFile(join(feature, name), "Contract fixture only, not business acceptance")
  await writeFile(join(feature, "REQUIREMENTS_EVAL.md"), "verdict: PASS\nContract fixture only")
  await withPinnedAutobiz(undefined, (source) =>
    promisify(execFile)(
      "python",
      [
        "-I",
        "-B",
        "-c",
        "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync; r=check_or_fix_state_sync(Path(sys.argv[2]),fix=True); assert not r.errors,r.errors",
        source,
        root
      ],
      { windowsHide: true }
    )
  )
  const before = await readFile(state)
  const input = {
    workspace: root,
    feature: "order-export",
    from: "requirements_eval_in_progress",
    to: "requirements_eval_done",
    expectedStateFingerprint: hash(before),
    idempotencyKey: "once"
  }
  return { parent, root, state, directory, before, input }
}

it("does not trust workspace-forged receipts", async () => {
  const f = await fixture()
  await writeFile(
    join(f.directory, `.mods-v2-transition-${hash("once")}.json`),
    JSON.stringify({
      feature: f.input.feature,
      from: f.input.from,
      to: f.input.to,
      stateFingerprint: hash(f.before),
      applied: true,
      duplicate: false
    })
  )
  const result = await advanceAutobizCheckpoint(f.input)
  expect(result.duplicate, JSON.stringify(result)).toBe(false)
  expect(result.applied, result.reason).toBe(true)
  expect(JSON.parse(await readFile(f.state, "utf8")).features["order-export"].checkpoint).toBe(
    f.input.to
  )
})

it("never prepares or writes when a duplicate-only request has no committed host receipt", async () => {
  const f = await fixture()
  let verified = false
  const result = await advanceAutobizCheckpoint({
    ...f.input,
    requireCommittedReceipt: true,
    verifyEvidence: async () => {
      verified = true
    }
  })
  expect(result.applied, JSON.stringify(result)).toBe(false)
  expect(result.duplicate).toBe(false)
  expect(result.reason).toBe("AUTOBIZ_RECEIPT_REQUIRED")
  expect(verified).toBe(false)
  expect(await readFile(f.state)).toEqual(f.before)
})

it("refuses a writer already open before acquiring state handles", async () => {
  const f = await fixture()
  const writer = await open(f.state, "r+")
  try {
    const result = await advanceAutobizCheckpoint(f.input)
    expect(result.applied, JSON.stringify(result)).toBe(false)
    expect(result.reason).toContain("AUTOBIZ_STATE_LOCKED")
    expect(await readFile(f.state)).toEqual(f.before)
  } finally {
    await writer.close()
  }
})

it("excludes new writers and renames while allowing host evidence reads", async () => {
  const f = await fixture()
  let verified = false
  const result = await advanceAutobizCheckpoint({
    ...f.input,
    verifyEvidence: async () => {
      expect(await readFile(f.state)).toEqual(f.before)
      await expect(
        open(f.state, "r+").then(async (handle) => {
          await handle.close()
        })
      ).rejects.toThrow()
      await expect(rename(f.state, `${f.state}.moved`)).rejects.toThrow()
      await expect(rename(f.directory, `${f.directory}-moved`)).rejects.toThrow()
      await expect(rename(f.root, `${f.root}-moved`)).rejects.toThrow()
      verified = true
    }
  })
  expect(verified, result.reason).toBe(true)
  expect(result.applied, result.reason).toBe(true)
})

it("does not attribute an already advanced checkpoint to an unrelated key", async () => {
  const f = await fixture()
  const first = await advanceAutobizCheckpoint(f.input)
  expect(first.applied, first.reason).toBe(true)
  const unrelated = await advanceAutobizCheckpoint({
    ...f.input,
    expectedStateFingerprint: first.stateFingerprint,
    idempotencyKey: "unrelated"
  })
  expect(unrelated.duplicate, JSON.stringify(unrelated)).toBe(false)
  expect(unrelated.applied).toBe(false)
  expect(unrelated.reason).toContain("AUTOBIZ_CHECKPOINT_UNATTRIBUTED")
})

it("checks both JSON and Markdown before returning a trusted duplicate", async () => {
  const f = await fixture()
  const first = await advanceAutobizCheckpoint(f.input)
  expect(first.applied, first.reason).toBe(true)
  const duplicate = await advanceAutobizCheckpoint(f.input)
  expect(duplicate.duplicate, duplicate.reason).toBe(true)
  await writeFile(join(f.directory, "STATE.md"), "external projection change")
  const changed = await advanceAutobizCheckpoint(f.input)
  expect(changed.duplicate, JSON.stringify(changed)).toBe(false)
  expect(changed.reason).toContain("AUTOBIZ_STATE_CHANGED")
})

it.each(["after-ack", "partial"])(
  "retains unknown across restart after %s process death",
  async (fault) => {
    const f = await fixture()
    const beforeMd = await readFile(join(f.directory, "STATE.md"))
    isolated.fault = fault
    const lost = await advanceAutobizCheckpoint(f.input)
    expect(lost.status, JSON.stringify(lost)).toBe("unknown")
    expect(lost.applied).toBe(false)
    expect(lost.duplicate).toBe(false)
    const observed = await readFile(f.state)
    if (fault === "partial") expect(observed).not.toEqual(f.before)
    else expect(observed).toEqual(f.before)
    expect(await readFile(join(f.directory, "STATE.md"))).toEqual(beforeMd)
    isolated.fault = ""
    // Each invocation closes/reopens the host DB and launches a fresh child.
    const restarted = await advanceAutobizCheckpoint({ ...f.input, idempotencyKey: "fresh-grant" })
    expect(restarted.status).toBe("unknown")
    expect(restarted.reason).toContain(lost.operationId)
    expect(restarted.operationId).toBe(lost.operationId)
    expect(await readFile(f.state)).toEqual(observed)
  }
)

it("does not leave an intent or mutate files on cancellation before ACK", async () => {
  const f = await fixture()
  const controller = new AbortController()
  await expect(
    advanceAutobizCheckpoint({
      ...f.input,
      signal: controller.signal,
      verifyEvidence: async () => {
        controller.abort(Error("cancel before ACK"))
      }
    })
  ).rejects.toThrow(/cancel before ACK|abort/i)
  expect(await readFile(f.state)).toEqual(f.before)
  const retry = await advanceAutobizCheckpoint(f.input)
  expect(retry.applied, retry.reason).toBe(true)
})

it("does not turn cancellation after writing both files into a successful retry", async () => {
  const f = await fixture()
  const controller = new AbortController()
  isolated.abort = () => controller.abort(Error("revoked after write"))
  const cancelled = await advanceAutobizCheckpoint({ ...f.input, signal: controller.signal })
  expect(cancelled.status, JSON.stringify(cancelled)).toBe("unknown")
  expect(cancelled.applied).toBe(false)
  expect(await readFile(f.state)).not.toEqual(f.before)
  isolated.abort = undefined
  const retry = await advanceAutobizCheckpoint(f.input)
  expect(retry.status).toBe("unknown")
  expect(retry.duplicate).toBe(false)
})

it("blocks after a timeout past the commit ACK", async () => {
  const f = await fixture()
  isolated.fault = "timeout-after-ack"
  const timedOut = await advanceAutobizCheckpoint({ ...f.input, timeoutMs: 2000 })
  expect(timedOut.status, JSON.stringify(timedOut)).toBe("unknown")
  expect(await readFile(f.state)).toEqual(f.before)
  isolated.fault = ""
  expect((await advanceAutobizCheckpoint(f.input)).status).toBe("unknown")
})

it("serializes competing requests through real state handles", async () => {
  const f = await fixture()
  const first = await advanceAutobizCheckpoint({
    ...f.input,
    verifyEvidence: async () => {
      const second = await advanceAutobizCheckpoint({ ...f.input, idempotencyKey: "competition" })
      expect(second.applied).toBe(false)
      expect(second.reason).toContain("AUTOBIZ_STATE_LOCKED")
    }
  })
  expect(first.applied, first.reason).toBe(true)
})

it("refuses a writable mapping that existed before locking", async () => {
  const f = await fixture()
  const child = spawn(
    "python",
    [
      "-I",
      "-B",
      "-c",
      "import mmap,sys; f=open(sys.argv[1],'r+b'); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE); f.close(); print('ready',flush=True); sys.stdin.readline(); m.close()",
      f.state
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  )
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve())
      child.once("error", reject)
    })
    const result = await advanceAutobizCheckpoint(f.input)
    expect(result.applied, JSON.stringify(result)).toBe(false)
    expect(result.reason).toContain("AUTOBIZ_STATE_LOCKED")
  } finally {
    child.stdin.end("close\n")
    await closed
  }
})

it("refuses a host journal root inside the untrusted workspace", async () => {
  const f = await fixture()
  isolated.root = join(f.root, "fake-host")
  const result = await advanceAutobizCheckpoint(f.input)
  expect(result.reason).toContain("AUTOBIZ_JOURNAL_UNTRUSTED")
  expect(await readFile(f.state)).toEqual(f.before)
})

it("refuses junction-backed state paths", async () => {
  const f = await fixture()
  const relocated = join(f.parent, "relocated")
  await rename(f.directory, relocated)
  await symlink(relocated, f.directory, "junction")
  const result = await advanceAutobizCheckpoint(f.input)
  expect(result.reason).toContain("AUTOBIZ_REPARSE_UNSUPPORTED")
  expect(await readFile(f.state)).toEqual(f.before)
})

it("fails closed on an unsupported platform", async () => {
  const f = await fixture()
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" })
    const result = await advanceAutobizCheckpoint(f.input)
    expect(result.reason).toBe("AUTOBIZ_COMMIT_PLATFORM_UNSUPPORTED")
    expect(result.applied).toBe(false)
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
  expect(await readFile(f.state)).toEqual(f.before)
})
