import { afterEach, expect, it, vi } from "vitest"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotHostLog } from "./host-log"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(maxBytes = 1024) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cmb-host-log-")))
  roots.push(root)
  return { root, logger: new BotHostLog(root, maxBytes), path: join(root, "host.log") }
}

it("retains randomly phone-shaped task UUIDs in file and console diagnostics while masking sensitive fields", () => {
  const { logger, path } = fixture(8192)
  const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const printed = target.info
  const restore = logger.install(target)
  const id = "19911645-654b-465e-a0b9-a82b11abeb40"
  try {
    target.info("[BotModelCall]", { runId: id, rootRunId: id, apiKey: id, phone: "13800138000" })
    for (const text of [readFileSync(path, "utf8"), JSON.stringify(printed.mock.calls)]) {
      expect(text).toContain(`"runId":"${id}"`)
      expect(text).toContain('"apiKey":"[REDACTED]"')
      expect(text).not.toContain("13800138000")
    }
  } finally {
    restore()
  }
})

it("reuses desktop redaction for file diagnostics and stdout, including Error details", () => {
  const { root, path, logger } = fixture(8192)
  const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const original = target.error
  const restore = logger.install(target)
  target.error("model failed", new Error("Authorization: Bearer hidden-provider-key"), {
    apiKey: "hidden-api-key",
    cookie: "hidden-cookie",
    url: "https://test.invalid/?token=hidden-query"
  })
  const stored = readFileSync(path, "utf8"),
    printed = JSON.stringify(original.mock.calls)
  for (const text of [stored, printed]) {
    expect(text).toContain("model failed")
    expect(text).toContain("REDACTED")
    expect(text).not.toMatch(/hidden-(provider-key|api-key|cookie|query)/)
  }
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readdirSync(root)).toEqual(["host.log"])
  restore()
  expect(target.error).toBe(original)
})

it("bounds every UTF-8 record and rotates only the current log plus two generations", () => {
  const { root, logger, path } = fixture()
  for (let index = 0; index < 18; index++)
    logger.append("info", [`entry-${index}`, "你好🙂".repeat(25000)])
  expect(readdirSync(root).sort()).toEqual(["host.log", "host.log.1", "host.log.2"])
  for (const name of readdirSync(root)) {
    const bytes = readFileSync(join(root, name))
    expect(bytes.length).toBeLessThanOrEqual(1024)
    expect(bytes.toString()).not.toContain("�")
    expect(bytes.toString()).toContain("log truncated")
    expect(bytes.at(-1)).toBe(10)
  }
  expect(readFileSync(path, "utf8")).toContain("entry-17")
  expect(readFileSync(path + ".2", "utf8")).toContain("entry-15")
})

it("handles cycles, bigint and hostile getters without evaluating user code", () => {
  const { logger, path } = fixture(8192)
  const getter = vi.fn(() => {
      throw new Error("getter executed")
    }),
    custom = vi.fn(() => {
      throw new Error("toJSON executed")
    })
  const input: Record<string, unknown> = { count: 2n, toJSON: custom }
  input.self = input
  Object.defineProperty(input, "value", { get: getter, enumerable: true })
  expect(() =>
    logger.append("log", [input, undefined, new Proxy({}, { ownKeys: getter })])
  ).not.toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(custom).not.toHaveBeenCalled()
  const text = readFileSync(path, "utf8")
  expect(text).toContain("Circular")
  expect(text).toContain("Getter")
  expect(text).toContain("2n")
})

it.each(["symlink", "hardlink"])("rejects a %s log without changing another file", (kind) => {
  const { root, logger, path } = fixture()
  const outside = join(root, "unrelated.txt")
  writeFileSync(outside, "untouched")
  if (kind === "symlink") symlinkSync(outside, path)
  else linkSync(outside, path)
  expect(() => logger.append("error", ["new diagnostic"])).not.toThrow()
  expect(readFileSync(outside, "utf8")).toBe("untouched")
})

it("does not write into a replaced root or a link replacing the original directory", () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "cmb-log-root-")))
  roots.push(outer)
  const root = join(outer, "root"),
    displaced = join(outer, "old"),
    outside = join(outer, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  const logger = new BotHostLog(root)
  logger.append("info", ["first"])
  renameSync(root, displaced)
  symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir")
  expect(() => logger.append("info", ["must not write"])).not.toThrow()
  expect(readdirSync(outside)).toEqual([])
  expect(readFileSync(join(displaced, "host.log"), "utf8")).not.toContain("must not write")
})

it("drops instead of growing a blocked log and reports omissions when the sink recovers", () => {
  const { logger, path } = fixture()
  writeFileSync(path, "x".repeat(1024))
  mkdirSync(path + ".2")
  for (let index = 0; index < 20; index++) logger.append("warn", ["rotation is blocked"])
  expect(statSync(path).size).toBe(1024)
  rmSync(path + ".2", { recursive: true })
  logger.append("info", ["sink recovered"])
  expect(readFileSync(path, "utf8")).toContain("20 earlier log entries unavailable")
  expect(readFileSync(path, "utf8")).toContain("sink recovered")
})

it("preserves the file diagnostic when stdout is closed and does not clobber a later console wrapper", () => {
  const { logger, path } = fixture()
  const target = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn<(...args: unknown[]) => void>().mockImplementation(() => {
      throw new Error("EPIPE")
    }),
    debug: vi.fn()
  }
  const restore = logger.install(target)
  expect(() => target.error("important error")).not.toThrow()
  expect(readFileSync(path, "utf8")).toContain("important error")
  const later = vi.fn()
  target.error = later
  restore()
  expect(target.error).toBe(later)
})
