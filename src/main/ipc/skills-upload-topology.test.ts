import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { IpcMain } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const uploadIo = vi.hoisted(() => ({
  mode: "normal" as "normal" | "delay" | "fail" | "lost",
  release: null as (() => void) | null,
  started: null as (() => void) | null
}))

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: vi.fn() }
}))

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
  return {
    ...actual,
    rename: async (...args: unknown[]) => {
      const target = String(args[1])
      if (target.endsWith(join("skills", "delayed-upload"))) {
        uploadIo.started?.()
        if (uploadIo.mode === "delay") {
          await new Promise<void>((resolve) => {
            uploadIo.release = resolve
          })
        }
        if (uploadIo.mode === "fail") {
          const error = new Error("injected upload failure") as NodeJS.ErrnoException
          error.code = "EIO"
          throw error
        }
        if (uploadIo.mode === "lost") {
          await Reflect.apply(actual.rename, actual, args)
          throw new Error("injected interruption after directory publication")
        }
      }
      return Reflect.apply(actual.rename, actual, args)
    }
  }
})

type UploadResult = { success: boolean; skillName?: string; error?: string }
type UploadHandler = (
  event: unknown,
  payload: {
    buffer: ArrayBuffer
    fileName: string
    options?: { expectedSha256?: string; importId?: string }
  }
) => Promise<UploadResult>

describe("skill upload topology fence", () => {
  let tempRoot: string
  let isolatedHome: string
  const previousOverride = process.env.CMB_COWORK_AGENT_HOME

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "cmb-skill-upload-"))
    isolatedHome = join(tempRoot, "app-data")
    process.env.CMB_COWORK_AGENT_HOME = isolatedHome
    uploadIo.mode = "normal"
    uploadIo.release = null
    uploadIo.started = null
    vi.resetModules()
  })

  afterEach(async () => {
    uploadIo.release?.()
    if (previousOverride === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previousOverride
    vi.resetModules()
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function uploadHandler(): Promise<UploadHandler> {
    const handlers = new Map<string, UploadHandler>()
    const ipcMain = {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as UploadHandler)
      }
    } as unknown as IpcMain
    const { registerSkillsHandlers } = await import("./skills")
    registerSkillsHandlers(ipcMain)
    const handler = handlers.get("skills:upload")
    if (!handler) throw new Error("skills:upload handler was not registered")
    return handler
  }

  function markdownPayload(): { buffer: ArrayBuffer; fileName: string } {
    const bytes = Buffer.from("---\nname: delayed-upload\n---\n\nbody\n")
    return {
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      fileName: "delayed-upload.md"
    }
  }

  it("keeps disabled mutation scans waiting until a delayed upload is complete", async () => {
    uploadIo.mode = "delay"
    const started = new Promise<void>((resolve) => {
      uploadIo.started = resolve
    })
    const handler = await uploadHandler()
    const upload = handler({}, markdownPayload())
    await started

    const topology = await import("../skill-plugin-catalog/topology-mutation-gate")
    const storage = await import("../storage")
    const { commitCanonicalDisabledSkillMutation } =
      await import("../skills/disabled-state-mutation")
    const { DISABLED_SKILL_STORE_MISSING_FINGERPRINT } =
      await import("../skills/disabled-store-fingerprint")
    expect(topology.isSkillCatalogTopologyMutationBusy()).toBe(true)
    let scans = 0
    const toggle = commitCanonicalDisabledSkillMutation(
      async () => {
        scans += 1
        return {
          kind: "disabled" as const,
          sourceKey: `fresh-${scans}`,
          catalogGlobalRevision: topology.getSkillCatalogTopologyRevision(),
          disabledSkillsRevision: storage.getDisabledSkillsRevision(),
          disabledStoreFingerprint: DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
          skills: [],
          plugins: [],
          disabledSkillIds: [],
          cursor: null,
          total: 0,
          enabledSkillCount: 0,
          truncated: false,
          truncatedReasons: [],
          stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 }
        }
      },
      (snapshot) =>
        storage.compareAndSetSkillDisabledState(
          "delayed-upload",
          true,
          snapshot.disabledSkillIds,
          snapshot.sourceRevision,
          snapshot.storeFingerprint,
          snapshot.catalogGlobalRevision
        )?.disabledSkillIds ?? null
    )
    await Promise.resolve()
    expect(scans).toBe(0)

    uploadIo.release?.()
    await expect(upload).resolves.toMatchObject({ success: true })
    await expect(toggle).resolves.toEqual(["delayed-upload"])
    expect(scans).toBe(1)
  })

  it("keeps a failed staged upload out of the live skill catalog", async () => {
    uploadIo.mode = "fail"
    const handler = await uploadHandler()
    await expect(handler({}, markdownPayload())).resolves.toMatchObject({ success: false })
    expect(existsSync(join(isolatedHome, "skills", "delayed-upload"))).toBe(false)
  })

  it("never removes a pre-existing collision directory", async () => {
    const collisionDir = join(isolatedHome, "skills", "delayed-upload")
    await mkdir(collisionDir, { recursive: true })
    await writeFile(join(collisionDir, "owner.txt"), "keep")
    uploadIo.mode = "fail"
    const handler = await uploadHandler()

    await expect(handler({}, markdownPayload())).resolves.toMatchObject({ success: false })
    await expect(readFile(join(collisionDir, "owner.txt"), "utf-8")).resolves.toBe("keep")
  })

  it("recovers a publication interrupted before its receipt without rewriting files", async () => {
    const handler = await uploadHandler()
    const input = { ...markdownPayload(), options: { importId: randomUUID() } }
    uploadIo.mode = "lost"
    await expect(handler({}, input)).resolves.toMatchObject({ success: false })
    const path = join(isolatedHome, "skills", "delayed-upload", "SKILL.md")
    const { stat } = await import("node:fs/promises")
    const before = await stat(path)
    uploadIo.mode = "normal"
    await expect(handler({}, input)).resolves.toMatchObject({
      success: true,
      skillName: "delayed-upload"
    })
    expect((await stat(path)).ino).toBe(before.ino)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    // A completed receipt is historical. Replay preserves later edits/deletion.
    await writeFile(path, "USER_EDIT")
    await expect(handler({}, input)).resolves.toMatchObject({ success: true })
    expect(await readFile(path, "utf8")).toBe("USER_EDIT")
    await rm(join(isolatedHome, "skills", "delayed-upload"), { recursive: true })
    await expect(handler({}, input)).resolves.toMatchObject({ success: true })
    expect(existsSync(path)).toBe(false)
  })

  it("retains changed files after an uncertain publication and rejects reuse with different content", async () => {
    const handler = await uploadHandler()
    const input = { ...markdownPayload(), options: { importId: randomUUID() } }
    uploadIo.mode = "lost"
    await expect(handler({}, input)).resolves.toMatchObject({ success: false })
    const path = join(isolatedHome, "skills", "delayed-upload", "SKILL.md")
    await writeFile(path, "USER_EDIT")
    uploadIo.mode = "normal"
    await expect(handler({}, input)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("核对")
    })
    expect(await readFile(path, "utf8")).toBe("USER_EDIT")
    await expect(
      handler(
        {},
        {
          ...input,
          buffer: new TextEncoder().encode("---\nname: different\n---\nchanged").buffer
        }
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("内容已变化") })
  })

  it("retries a prepared import after publication failed without exposing a partial skill", async () => {
    const handler = await uploadHandler()
    const input = { ...markdownPayload(), options: { importId: randomUUID() } }
    uploadIo.mode = "fail"
    await expect(handler({}, input)).resolves.toMatchObject({ success: false })
    expect(existsSync(join(isolatedHome, "skills", "delayed-upload"))).toBe(false)
    uploadIo.mode = "normal"
    await expect(handler({}, input)).resolves.toMatchObject({ success: true })
    expect(
      await readFile(join(isolatedHome, "skills", "delayed-upload", "SKILL.md"), "utf8")
    ).toContain("body")
  })

  it("rejects changed preview bytes and unsafe directory names before any installation", async () => {
    const handler = await uploadHandler()
    await expect(
      handler({}, { ...markdownPayload(), options: { expectedSha256: "0".repeat(64) } })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("重新预览")
    })
    expect(existsSync(join(isolatedHome, "skills", "delayed-upload"))).toBe(false)
    for (const name of ["CON", "../", "..."]) {
      const buffer = new TextEncoder().encode(`---\nname: ${name}\n---\nbody`).buffer
      await expect(handler({}, { buffer, fileName: "SKILL.md" })).resolves.toMatchObject({
        success: false
      })
    }
  })
})
