import { afterEach, describe, expect, it, vi } from "vitest"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
vi.mock("../harness-board/project-runtime/safe-files-async", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../harness-board/project-runtime/safe-files-async")>()
  return { ...actual, readRuntimeScopedFileAsync: vi.fn(actual.readRuntimeScopedFileAsync) }
})
import { readRuntimeScopedFileAsync } from "../harness-board/project-runtime/safe-files-async"

const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const skill = {
  id: "review",
  title: "Review",
  kind: "skill",
  usage: "universal",
  entry: "skills/review/SKILL.md"
}
const flow = {
  id: "flow",
  title: "Delivery",
  kind: "flow",
  usage: "project",
  entry: "devclaw.project-runtime.json"
}
function fixture(capabilities: unknown[] | undefined = [skill]) {
  const root = mkdtempSync(join(tmpdir(), "capability-catalog-"))
  roots.push(root)
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  put("plugin.json", JSON.stringify({ name: "docs", version: "1.0.0" }))
  put(skill.entry, "---\nname: review\ndescription: Review a document\n---\nReview carefully.")
  if (capabilities)
    put(
      "devclaw.capabilities.json",
      JSON.stringify({ apiVersion: "devclaw.capabilities/v1", capabilities })
    )
  return {
    root,
    put,
    plugin: { id: "installed-id", name: "docs", version: "1.0.0", path: root, enabled: true }
  }
}

describe("read-only native capability catalog", async () => {
  it("distinguishes a scan deadline from structural limits and permits a fresh retry", async () => {
    const f = fixture()
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(3001)
    try {
      const result = await readNativeCapabilityCatalog(f.plugin, "project")
      expect(result).toMatchObject({ status: "invalid", capabilities: [], packageDigest: null })
      expect(result.reasons).toEqual(["CAPABILITY_PACKAGE_TIMEOUT"])
    } finally {
      clock.mockRestore()
    }
    expect((await readNativeCapabilityCatalog(f.plugin, "project")).status).toBe("declared")
    f.put(`${"nested/".repeat(17)}file.txt`, "depth limit")
    expect((await readNativeCapabilityCatalog(f.plugin, "project")).reasons).toEqual([
      "CAPABILITY_PACKAGE_LIMIT"
    ])
  })
  it("bounds parallel safe file reads to eight and settles all workers on cancellation", async () => {
    const f = fixture()
    for (let index = 0; index < 24; index++) f.put(`assets/${index}.txt`, "file")
    for (let index = 0; index < 12; index++) f.put(`nested/child/${index}.txt`, "nested")
    const real = await vi.importActual<
      typeof import("../harness-board/project-runtime/safe-files-async")
    >("../harness-board/project-runtime/safe-files-async")
    let active = 0
    let peak = 0
    let abort: AbortController | undefined
    const reader = vi.mocked(readRuntimeScopedFileAsync)
    reader.mockImplementation(async (...args) => {
      active++
      peak = Math.max(peak, active)
      if (abort && active === 8) abort.abort(Error("cancel group"))
      try {
        return await real.readRuntimeScopedFileAsync(...args)
      } finally {
        active--
      }
    })
    try {
      expect((await readNativeCapabilityCatalog(f.plugin, "project")).status).toBe("declared")
      expect(peak).toBe(8)
      expect(active).toBe(0)
      abort = new AbortController()
      await expect(readNativeCapabilityCatalog(f.plugin, "project", abort.signal)).rejects.toThrow(
        "cancel group"
      )
      expect(active).toBe(0)
      expect(peak).toBe(8)
    } finally {
      reader.mockImplementation(real.readRuntimeScopedFileAsync)
    }
  })
  it("uses the same package identity as the real retained host snapshot", async () => {
    const f = fixture([flow])
    f.put(flow.entry, JSON.stringify(hostProjectFixture(f.root).manifest))
    f.put("skills/draft/SKILL.md", "Draft")
    f.put("a/z.txt", "nested")
    f.put("a-.txt", "ordinal sorting differs from directory traversal")
    const retained = mkdtempSync(join(tmpdir(), "capability-snapshot-"))
    roots.push(retained)
    const catalog = await readNativeCapabilityCatalog(f.plugin, "project")
    const snapshot = new HostPackageSnapshots(retained).capture(f.root)
    expect(catalog.status).toBe("declared")
    expect(catalog.packageDigest).toBe(snapshot.digest)
  })
  it("keeps undeclared packages on the original project entry without invented capabilities", async () => {
    const f = fixture(undefined)
    // Explicit undefined uses the fixture default; remove only this test-owned declaration.
    rmSync(join(f.root, "devclaw.capabilities.json"))
    const result = await readNativeCapabilityCatalog(f.plugin, "project")
    expect(result.status).toBe("undeclared")
    expect(result.capabilities).toEqual([])
    expect(result.reasons.join()).toContain("原有单插件项目入口")
  })
  it("returns exact installation and content identity without executing plugin code", async () => {
    const f = fixture()
    f.put("entry.js", "throw Error('must never execute')")
    const before = readFileSync(join(f.root, skill.entry))
    const result = await readNativeCapabilityCatalog(f.plugin, "chat")
    expect(result.status).toBe("declared")
    expect(result.packageDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.capabilities[0]).toMatchObject({
      source: { pluginId: "installed-id", name: "docs", version: "1.0.0" },
      applicable: true,
      available: false
    })
    expect(result.capabilities[0].reasons.join()).toContain("需宿主验证")
    expect(readFileSync(join(f.root, skill.entry))).toEqual(before)
    f.put("entry.js", "throw Error('changed')")
    expect((await readNativeCapabilityCatalog(f.plugin, "chat")).packageDigest).not.toBe(
      result.packageDigest
    )
    expect(
      (await readNativeCapabilityCatalog({ ...f.plugin, id: "another" }, "chat")).capabilities[0]
        .identity
    ).not.toBe(result.capabilities[0].identity)
  })
  it("marks actual stage skills and project flows conservatively, preserving original checks", async () => {
    const f = fixture([skill, flow])
    const runtime = hostProjectFixture(f.root).manifest
    f.put("skills/draft/SKILL.md", "Draft")
    f.put(flow.entry, JSON.stringify(runtime))
    const result = await readNativeCapabilityCatalog(f.plugin, "chat")
    expect(result.capabilities[0].stageIds).toEqual(["review"])
    expect(result.capabilities[0].reasons.join()).toContain("需要项目流程上下文")
    expect(result.capabilities[1]).toMatchObject({
      applicable: false,
      available: false,
      runtimeMode: "host"
    })
    runtime.mode = "legacy"
    runtime.stateOwner = "plugin"
    f.put(flow.entry, JSON.stringify(runtime))
    expect(
      (await readNativeCapabilityCatalog(f.plugin, "project")).capabilities[1].reasons.join()
    ).toContain("独立状态根")
  })
  it("does not accept absent skill entries, arbitrary files, malformed runtimes or mismatched identities", async () => {
    for (const entry of ["skills/missing/SKILL.md", "plugin.json"]) {
      const f = fixture([{ ...skill, entry }])
      expect(
        (await readNativeCapabilityCatalog(f.plugin, "project")).capabilities[0].reasons.join()
      ).toContain("真实 SKILL.md")
    }
    const f = fixture([flow])
    f.put(flow.entry, "{}")
    expect(
      (await readNativeCapabilityCatalog(f.plugin, "project")).capabilities[0].reasons.join()
    ).toContain("有效运行声明")
    expect(
      (await readNativeCapabilityCatalog({ ...f.plugin, version: "2" }, "project")).status
    ).toBe("invalid")
  })
  it("rejects oversized declarations, hardlinks and linked directory escapes", async () => {
    const large = fixture()
    large.put("devclaw.capabilities.json", " ".repeat(65537))
    expect((await readNativeCapabilityCatalog(large.plugin, "chat")).status).toBe("invalid")
    const hard = fixture()
    linkSync(join(hard.root, skill.entry), join(hard.root, "duplicate.md"))
    expect((await readNativeCapabilityCatalog(hard.plugin, "chat")).status).toBe("invalid")
    const linked = fixture()
    const outside = fixture()
    symlinkSync(
      outside.root,
      join(linked.root, "outside"),
      process.platform === "win32" ? "junction" : "dir"
    )
    expect((await readNativeCapabilityCatalog(linked.plugin, "chat")).status).toBe("invalid")
  })
  it("refuses sensitive package paths without reporting their contents", async () => {
    const f = fixture()
    f.put(".env", "private-value")
    const result = await readNativeCapabilityCatalog(f.plugin, "chat")
    expect(result.status).toBe("invalid")
    expect(JSON.stringify(result)).not.toContain("private-value")
  })
  it("allows event-loop progress throughout both complete package scans", async () => {
    const f = fixture()
    for (let index = 0; index < 16; index++) f.put(`assets/${index}.txt`, "x".repeat(512 * 1024))
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 0)
    try {
      const result = await readNativeCapabilityCatalog(f.plugin, "chat")
      expect(result.status).toBe("declared")
      expect(ticks).toBeGreaterThan(3)
    } finally {
      clearInterval(heartbeat)
    }
  })
  it("rejects cancellation before reading and during a scan without publishing a partial catalog", async () => {
    const f = fixture()
    const before = new AbortController()
    before.abort()
    await expect(
      readNativeCapabilityCatalog(f.plugin, "chat", before.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    for (let index = 0; index < 16; index++) f.put(`assets/${index}.txt`, "x".repeat(512 * 1024))
    const during = new AbortController()
    let ticks = 0
    const heartbeat = setInterval(() => {
      if (++ticks === 3) during.abort()
    }, 0)
    try {
      await expect(
        readNativeCapabilityCatalog(f.plugin, "project", during.signal)
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(ticks).toBeGreaterThanOrEqual(3)
    } finally {
      clearInterval(heartbeat)
    }
    // Cancellation releases file descriptors and does not poison the next explicit read.
    expect((await readNativeCapabilityCatalog(f.plugin, "project")).status).toBe("declared")
  })
})
