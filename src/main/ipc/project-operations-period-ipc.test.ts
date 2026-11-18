import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  ScriptTarget,
  transpileModule,
  type Node
} from "typescript"
import { describe, expect, it, vi } from "vitest"
import { parseProjectOperationsPeriodInput } from "./project-operations-period"

// Execute the actual registered handler without booting Electron or querying an internal service.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
let registration = ""
function visit(node: Node): void {
  if (
    isCallExpression(node) &&
    node.expression.getText(source) === "registerLatestDashboardHandler" &&
    node.arguments[1]?.getText(source) === '"dashboard:projectModePeriodMetrics"'
  )
    registration = node.getText(source)
  forEachChild(node, visit)
}
visit(source)
expect(registration).not.toBe("")
const compiled = transpileModule(registration, {
  compilerOptions: { target: ScriptTarget.ES2022 }
}).outputText
const input = { period: { kind: "month", month: "2026-11" }, upperOrgLv1: "甲室" }

function fixture() {
  const access = { admin: false, upperOrgLv1: "甲室" }
  const controller = new AbortController()
  const requireAccess = vi.fn(() => access)
  const fetchData = vi.fn(async () => ({ room: "甲室" }))
  let handler!: (_event: unknown, request: unknown) => Promise<Record<string, unknown>>
  runInNewContext(compiled, {
    Error,
    _ipcMain: {},
    registerLatestDashboardHandler: (_ipc: unknown, _channel: string, fn: typeof handler) => {
      handler = fn
    },
    parseProjectOperationsPeriodInput,
    requireDashboardProjectModeAccess: requireAccess,
    isDashboardProjectModeAdmin: (value: typeof access) => value.admin,
    buildProjectModeOrgFilter: (request: typeof input) => ({
      term: { upperOrgLv1: request.upperOrgLv1 }
    }),
    fetchProjectOperationsPeriod: fetchData,
    getEsIndex: (name: string) => name,
    getDashboardRequestSignal: () => controller.signal,
    esQuery: vi.fn(),
    logDashboardRequestError: vi.fn()
  })
  return {
    access,
    controller,
    requireAccess,
    fetchData,
    call: (request: unknown = input) => handler({}, request)
  }
}

describe("period metrics IPC authorization", () => {
  it("rechecks access and rejects another room before reading statistics", async () => {
    const f = fixture()
    expect(await f.call({ ...input, upperOrgLv1: "乙室" })).toMatchObject({
      success: false,
      error: "无该室周期统计查看权限"
    })
    expect(f.fetchData).not.toHaveBeenCalled()
    expect(await f.call()).toMatchObject({ success: true })
    expect(f.fetchData).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        accessFilters: [{ term: { upperOrgLv1: "甲室" } }],
        signal: f.controller.signal
      }),
      expect.any(Function)
    )
    f.requireAccess.mockImplementation(() => {
      throw new Error("无查看权限")
    })
    expect(await f.call()).toMatchObject({ success: false, error: "无查看权限" })
    expect(f.fetchData).toHaveBeenCalledTimes(1)
  })
  it("lets administrators select exactly one room and validates malformed scope", async () => {
    const f = fixture()
    f.access.admin = true
    expect(await f.call({ ...input, upperOrgLv1: "乙室" })).toMatchObject({ success: true })
    expect(f.fetchData).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessFilters: [{ term: { upperOrgLv1: "乙室" } }] }),
      expect.any(Function)
    )
    expect(await f.call({ ...input, upperOrgLv1: ["甲室", "乙室"] })).toMatchObject({
      success: false
    })
    expect(await f.call({ ...input, person: { name: "同名员工" } })).toMatchObject({
      success: false
    })
    expect(f.fetchData).toHaveBeenCalledTimes(1)
  })
  it("propagates cancellation instead of presenting an empty successful report", async () => {
    const f = fixture()
    f.fetchData.mockImplementation(async () => {
      f.controller.abort()
      throw new Error("aborted")
    })
    expect(await f.call()).toEqual({ success: false, cancelled: true })
  })
})
