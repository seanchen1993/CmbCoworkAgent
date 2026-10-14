import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createAuthoringTemplate } from "./authoring-templates"
import { AuthoringPreflightClient } from "./authoring-preflight-client"
import { compileFunctionPlugin } from "../v2/loader"
import { readPureFunctionSource } from "./authoring-install-source"
import { AuthoringVersionRepository } from "./authoring-version-repository"

const installationId = "12345678-1234-4234-8234-123456789abc"
const source = () =>
  createAuthoringTemplate({ id: "test", name: "测试", instruction: "示例", kind: "command" })
let workerRoot: string
let workerEntry: string
let directory: string
beforeAll(async () => {
  workerRoot = mkdtempSync(resolve("output", "install-preflight-"))
  workerEntry = join(workerRoot, "preflight.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./authoring-preflight-entry.ts", import.meta.url))],
    outfile: workerEntry,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "staged-source-fallback",
        setup(builder) {
          builder.onResolve({ filter: /authoring-preflight-entry\.ts$/ }, (args) => {
            // Only output validation uses this fallback; after integration the source URL exists.
            if (args.path.includes("/staged/") || args.path.includes("\\staged\\"))
              return { path: resolve("src/main/mods/devtools/authoring-preflight-entry.ts") }
            return undefined
          })
        }
      }
    ]
  })
})
afterAll(() => {
  if (
    dirname(resolve(workerRoot)) !== resolve("output") ||
    !basename(workerRoot).startsWith("install-preflight-")
  )
    throw Error("TEST_CLEANUP_BOUNDARY")
  rmSync(workerRoot, { recursive: true, force: true })
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cmb-install-"))
})
afterEach(() => {
  vi.restoreAllMocks()
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("cmb-install-")
  )
    throw Error("TEST_CLEANUP_BOUNDARY")
  rmSync(directory, { recursive: true, force: true })
})
const repository = () => new AuthoringVersionRepository(join(directory, "versions"), workerEntry)
const input = () => ({
  installationId,
  workspace: "workspace",
  draftId: "draft",
  revision: 1,
  source: source(),
  signal: new AbortController().signal,
  assertCurrent: () => {}
})
const analysis = () => ({
  compiled: { digest: "a".repeat(64) },
  sdk: { strictCompatible: true },
  typecheck: { valid: true, digest: "a".repeat(64) }
})
const fakeChecks = () =>
  vi
    .spyOn(AuthoringPreflightClient.prototype, "run")
    .mockResolvedValue(analysis() as Awaited<ReturnType<AuthoringPreflightClient["run"]>>)

describe("immutable authoring preparation", () => {
  it("deletes only a validated unused record and honors a late retention decision", async () => {
    fakeChecks()
    const repo = repository()
    const first = await repo.prepare(input())
    const second = await repo.prepare(input())
    let observations = 0
    repo.collectUnreferenced("workspace", (record) => {
      if (record.versionId === first.record.versionId) return ++observations > 1
      return false
    })
    expect(repo.read(first.record.versionId)).toEqual(first.record)
    expect(() => repo.read(second.record.versionId)).toThrow()
    expect(readdirSync(join(directory, "versions"))).toEqual([first.record.versionId])
  })

  it("preserves the full library on corrupt inventory without stranding a live lock", async () => {
    fakeChecks()
    const repo = repository()
    const first = await repo.prepare(input())
    const second = await repo.prepare(input())
    writeFileSync(join(directory, "versions", second.record.versionId, "record.json"), "broken")
    expect(() => repo.collectUnreferenced("workspace", () => false)).toThrow()
    expect(repo.read(first.record.versionId)).toEqual(first.record)
    expect(readdirSync(join(directory, "versions"))).not.toContain(".prepare-lock")
    expect(
      readFileSync(join(directory, "versions", second.record.versionId, "record.json"), "utf8")
    ).toBe("broken")
  })

  it("runs the actual isolated Worker and retains exact source, without installation effects", async () => {
    const repo = repository(),
      request = input()
    const result = await repo.prepare(request)
    expect(result.record.source).toEqual(request.source)
    expect(result.record.coverage).toBe("prepared-source-only-v1")
    expect(repo.assertPrepared(result.token)).toEqual(result.record)
    expect((await compileFunctionPlugin(repo.preparedSourceDirectory(result.token))).digest).toBe(
      result.record.compiledDigest
    )
    expect(readdirSync(join(directory, "versions"))).toEqual([result.record.versionId])
    expect(
      readFileSync(
        join(directory, "versions", result.record.versionId, "source", "mods/main.ts"),
        "utf8"
      )
    ).toBe(request.source.files.find((file) => file.path === "mods/main.ts")!.text)
    const reopened = repository()
    expect(reopened.read(result.record.versionId)).toEqual(result.record)
    expect(() => reopened.assertPrepared(result.token)).toThrow("TOKEN")
    expect(() => repo.assertPrepared({ ...result.token })).toThrow("TOKEN")
    const fresh = await reopened.revalidate(result.record.versionId, {
      signal: new AbortController().signal,
      assertCurrent: () => {}
    })
    expect(reopened.assertPrepared(fresh.token)).toEqual(result.record)
    expect(readdirSync(join(directory, "versions"))).toEqual([result.record.versionId])
  }, 20_000)

  it("real Worker type failure cannot publish a version", async () => {
    const request = input()
    request.source = createAuthoringSourceBundle(
      request.source.files.map((file) =>
        file.path === "mods/main.ts"
          ? { ...file, text: file.text + "\nconst invalid: string = 42\n" }
          : file
      )
    )
    await expect(repository().prepare(request)).rejects.toThrow("CHECK_FAILED")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  }, 20_000)

  it.each([true, false])(
    "checks native single-entry userConfig through the actual Worker (valid=%s)",
    async (valid) => {
      const request = input()
      request.source = createAuthoringSourceBundle(
        request.source.files.map((file) =>
          file.path === "mods/manifest.json"
            ? {
                ...file,
                text: JSON.stringify({
                  apiVersion: "cmb.mods/v2",
                  id: "test",
                  entry: "main.ts",
                  userConfig: {
                    theme: {
                      type: "string",
                      title: "Theme",
                      description: "User preference",
                      default: valid ? "light" : 42
                    }
                  }
                })
              }
            : file
        )
      )
      const repo = repository()
      if (valid) {
        const result = await repo.prepare(request)
        expect(repo.assertPrepared(result.token).source).toEqual(request.source)
      } else {
        await expect(repo.prepare(request)).rejects.toThrow()
        expect(readdirSync(join(directory, "versions"))).toEqual([])
      }
    },
    20_000
  )

  it("serializes two repositories while the owned worker is still running", async () => {
    let release!: (value: ReturnType<typeof analysis>) => void
    vi.spyOn(AuthoringPreflightClient.prototype, "run").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release
        })
    )
    const first = repository().prepare(input())
    await expect(repository().prepare(input())).rejects.toThrow("BUSY")
    release(analysis())
    await first
  })

  it("captures source and binding before a caller callback changes them", async () => {
    fakeChecks()
    const request = input(),
      original = structuredClone(request.source)
    request.assertCurrent = () => {
      request.workspace = "other"
      request.source.files[0].text = "changed"
    }
    const prepared = await repository().prepare(request)
    expect(prepared.record.workspace).toBe("workspace")
    expect(prepared.record.source).toEqual(original)
  })

  it("revocation from the guard itself cleans its own unpublished directory", async () => {
    fakeChecks()
    const controller = new AbortController(),
      request = input()
    request.signal = controller.signal
    let count = 0
    request.assertCurrent = () => {
      if (++count === 3) controller.abort()
    }
    await expect(repository().prepare(request)).rejects.toThrow("CANCELLED")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("cleanup settlement precedes publication, including cancellation inside cleanup", async () => {
    fakeChecks()
    const controller = new AbortController(),
      request = input()
    request.signal = controller.signal
    let count = 0
    vi.spyOn(AuthoringPreflightClient.prototype, "stop").mockImplementation(async () => {
      if (++count === 2) controller.abort()
    })
    await expect(repository().prepare(request)).rejects.toThrow("CANCELLED")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("source changes during preflight cannot receive a preparation token", async () => {
    vi.spyOn(AuthoringPreflightClient.prototype, "run").mockImplementation(async (path) => {
      writeFileSync(join(path, "mods/main.ts"), "tampered")
      return analysis() as Awaited<ReturnType<AuthoringPreflightClient["run"]>>
    })
    await expect(repository().prepare(input())).rejects.toThrow("CHANGED")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("does not overwrite a version and invalidates tokens after disk tampering", async () => {
    fakeChecks()
    const repo = repository(),
      one = await repo.prepare(input()),
      two = await repo.prepare(input())
    expect(one.record.versionId).not.toBe(two.record.versionId)
    one.record.source.files[0].text = "mutated return"
    expect(repo.assertPrepared(one.token).source).toEqual(source())
    writeFileSync(
      join(directory, "versions", one.record.versionId, "source", "README.md"),
      "tamper"
    )
    expect(() => repo.assertPrepared(one.token)).toThrow("CHANGED")
    expect(repo.assertPrepared(two.token)).toEqual(two.record)
  })

  it("failed revalidation preserves source and rejects compiler changes and final cleanup revocation", async () => {
    const check = fakeChecks(),
      repo = repository(),
      prepared = await repo.prepare(input())
    check.mockResolvedValueOnce({ ...analysis(), compiled: { digest: "c".repeat(64) } } as Awaited<
      ReturnType<AuthoringPreflightClient["run"]>
    >)
    await expect(
      repo.revalidate(prepared.record.versionId, {
        signal: new AbortController().signal,
        assertCurrent: () => {}
      })
    ).rejects.toThrow("RECHECK_REQUIRED")
    const controller = new AbortController()
    vi.spyOn(AuthoringPreflightClient.prototype, "stop").mockImplementation(async () => {
      controller.abort()
    })
    await expect(
      repo.revalidate(prepared.record.versionId, {
        signal: controller.signal,
        assertCurrent: () => {}
      })
    ).rejects.toThrow("CANCELLED")
    expect(repo.read(prepared.record.versionId)).toEqual(prepared.record)
    expect(readdirSync(join(directory, "versions"))).toEqual([prepared.record.versionId])
  })

  it("retains every existing version and rejects capacity overflow", async () => {
    fakeChecks()
    const repo = repository()
    for (let i = 0; i < 16; i++) await repo.prepare(input())
    const before = readdirSync(join(directory, "versions"))
    await expect(repo.prepare(input())).rejects.toThrow("CAPACITY")
    expect(readdirSync(join(directory, "versions"))).toEqual(before)
  })

  it("bounds total physical source and snapshot bytes independently of version count", async () => {
    fakeChecks()
    const request = input()
    request.source = createAuthoringSourceBundle([
      ...source().files,
      ...["one", "two", "three"].map((name) => ({
        path: `mods/${name}.ts`,
        text: " ".repeat(64 * 1024)
      }))
    ])
    const repo = repository()
    let prepared = 0
    while (prepared < 16) {
      try {
        await repo.prepare(request)
        prepared++
      } catch (error) {
        expect(String(error)).toContain("CAPACITY")
        break
      }
    }
    expect(prepared).toBeGreaterThan(0)
    expect(prepared).toBeLessThan(16)
    expect(readdirSync(join(directory, "versions"))).toHaveLength(prepared)
  })

  it("cleans a record write collision without retaining a ready version", async () => {
    fakeChecks()
    const request = input()
    let count = 0
    request.assertCurrent = () => {
      if (++count !== 3) return
      const root = join(directory, "versions")
      const pending = readdirSync(root).find((name) => !name.startsWith("."))!
      writeFileSync(join(root, pending, "record.json"), "collision")
    }
    await expect(repository().prepare(request)).rejects.toThrow()
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("requires SDK checks as well as types and cleans worker failures", async () => {
    const run = fakeChecks()
    run.mockResolvedValueOnce({ ...analysis(), sdk: { strictCompatible: false } } as Awaited<
      ReturnType<AuthoringPreflightClient["run"]>
    >)
    await expect(repository().prepare(input())).rejects.toThrow("CHECK_FAILED")
    run.mockRejectedValueOnce(Error("worker exited"))
    await expect(repository().prepare(input())).rejects.toThrow("worker exited")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("rejects a source file changed and restored while checks execute", async () => {
    vi.spyOn(AuthoringPreflightClient.prototype, "run").mockImplementation(async (path) => {
      const target = join(path, "mods/main.ts"),
        original = readFileSync(target, "utf8")
      writeFileSync(target, "changed")
      writeFileSync(target, original)
      return analysis() as Awaited<ReturnType<AuthoringPreflightClient["run"]>>
    })
    await expect(repository().prepare(input())).rejects.toThrow("CHANGED")
    expect(readdirSync(join(directory, "versions"))).toEqual([])
  })

  it("leaves unknown crash directories and stale lock files for explicit reconciliation", async () => {
    const root = join(directory, "versions")
    mkdirSync(root)
    mkdirSync(join(root, ".preparing-crash"))
    await expect(repository().prepare(input())).rejects.toThrow("RECONCILE")
    expect(readdirSync(root)).toEqual([".preparing-crash"])
    writeFileSync(join(root, ".prepare-lock"), "")
    await expect(repository().prepare(input())).rejects.toThrow("BUSY")
    expect(readdirSync(root)).toContain(".prepare-lock")
  })

  it("rejects linked owned roots without deleting the linked contents", async () => {
    const target = join(directory, "outside")
    mkdirSync(target)
    writeFileSync(join(target, "keep"), "untouched")
    symlinkSync(target, join(directory, "versions"), "junction")
    await expect(repository().prepare(input())).rejects.toThrow("DIRECTORY")
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("untouched")
  })

  it.each([
    ".mcp.json",
    "hooks/hooks.json",
    "skills/test/SKILL.md",
    "package.json",
    ".claude-plugin/plugin.json"
  ])("rejects mixed or unexplained file %s even if malformed", (path) => {
    expect(() =>
      readPureFunctionSource(createAuthoringSourceBundle([...source().files, { path, text: "{" }]))
    ).toThrow("PURE_SOURCE")
  })

  it.each(["skills", "hooks", "mcpServers", "commands", "unknown"])(
    "rejects unsupported installation manifest declaration %s",
    (key) => {
      const files = source().files.map((file) =>
        file.path === "plugin.json"
          ? { ...file, text: JSON.stringify({ ...JSON.parse(file.text), [key]: [] }) }
          : file
      )
      expect(() => readPureFunctionSource(createAuthoringSourceBundle(files))).toThrow(
        "PURE_SOURCE"
      )
    }
  )
})
