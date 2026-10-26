import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { buildSync } from "esbuild"
import { expect, it, vi } from "vitest"

function fixture() {
  return {
    runId: "original-run",
    status: "completed",
    scriptSha256: "original-script",
    result: { status: "succeeded" },
    resultTruncated: false,
    actionCount: 4,
    worktreeCount: 2,
    worktreeOffset: 0,
    nextWorktreeOffset: 1 as number | null,
    worktrees: [{ id: "first" }]
  }
}
type Run = ReturnType<typeof fixture>
const module = {
  exports: {} as {
    readCodeWorktrees: (
      sdk: { platform: { read: () => Promise<unknown>; act: (input: unknown) => Promise<unknown> } },
      envelope: { executionId: string },
      run: Run
    ) => Promise<Run["worktrees"]>
  }
}
runInNewContext(
  buildSync({ entryPoints: [resolve("resources/native-compositions/autobiz-rules/mods/code-worktrees.ts")],
    bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles![0].text,
  { module, exports: module.exports }
)
function setup() {
  const run = fixture()
  const page = {
    ...fixture(),
    worktreeOffset: 1,
    nextWorktreeOffset: null,
    worktrees: [{ id: "second" }]
  } as Run
  const receipt = { status: "succeeded", value: { found: true, run: page } }
  const act = vi.fn(async () => receipt)
  return {
    run,
    page,
    receipt,
    act,
    read: () =>
      module.exports.readCodeWorktrees({ platform: { act, read: async () => ({ value: {
        status: "unavailable", code: "PROJECT_RUNTIME_PUBLIC_UNBOUND" } }) } }, { executionId: "check" }, run)
  }
}

it("follows bounded original resource pages without losing their facts", async () => {
  const value = setup()
  await expect(value.read()).resolves.toEqual([{ id: "first" }, { id: "second" }])
  expect(value.act).toHaveBeenCalledExactlyOnceWith({
    ref: { provider: "native.workflow", id: "runs", version: "1.0.0" },
    target: { kind: "current" },
    action: "inspect",
    input: { runId: "original-run", worktreeOffset: 1, actionOffset: 0, limit: 32 },
    requestKey: "check:code-worktrees:1"
  })
})

it("does not query again when the first page is complete", async () => {
  const value = setup()
  value.run.worktreeCount = 1
  value.run.nextWorktreeOffset = null
  await expect(value.read()).resolves.toEqual([{ id: "first" }])
  expect(value.act).not.toHaveBeenCalled()
})

it.each<[string, (value: ReturnType<typeof setup>) => void]>([
  [
    "over budget",
    ({ run }) => {
      run.worktreeCount = 9
    }
  ],
  [
    "nonzero first offset",
    ({ run }) => {
      run.worktreeOffset = 1
    }
  ],
  [
    "skipped offset",
    ({ run }) => {
      run.worktreeCount = 3
      run.nextWorktreeOffset = 2
    }
  ],
  [
    "repeated offset",
    ({ page }) => {
      page.nextWorktreeOffset = 1
    }
  ],
  [
    "missing page",
    ({ run }) => {
      run.nextWorktreeOffset = null
    }
  ],
  [
    "duplicate resource",
    ({ page }) => {
      page.worktrees[0].id = "first"
    }
  ],
  [
    "empty page",
    ({ page }) => {
      page.worktrees = []
    }
  ],
  [
    "excess rows",
    ({ page }) => {
      page.worktrees.push({ id: "third" })
    }
  ],
  [
    "wrong offset",
    ({ page }) => {
      page.worktreeOffset = 0
    }
  ],
  [
    "changed count",
    ({ page }) => {
      page.worktreeCount = 3
    }
  ],
  [
    "changed run",
    ({ page }) => {
      page.runId = "other"
    }
  ],
  [
    "changed source",
    ({ page }) => {
      page.scriptSha256 = "other"
    }
  ],
  [
    "changed result",
    ({ page }) => {
      page.result.status = "failed"
    }
  ],
  [
    "changed actions",
    ({ page }) => {
      page.actionCount++
    }
  ],
  [
    "truncated result",
    ({ page }) => {
      page.resultTruncated = true
    }
  ],
  [
    "failed receipt",
    ({ receipt }) => {
      receipt.status = "failed"
    }
  ]
])("rejects %s rather than accepting partial evidence", async (_name, change) => {
  const value = setup()
  change(value)
  await expect(value.read()).rejects.toThrow("AUTOBIZ_CODE_RESOURCE_PAGE_")
  expect(value.act.mock.calls.length).toBeLessThanOrEqual(1)
})
