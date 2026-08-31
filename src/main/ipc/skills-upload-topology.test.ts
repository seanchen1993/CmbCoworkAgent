import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const uploadIo = vi.hoisted(() => ({
  mode: "normal" as "normal" | "delay" | "fail",
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
    writeFile: async (...args: unknown[]) => {
      const target = String(args[0])
      if (target.endsWith(join("delayed-upload", "SKILL.md"))) {
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
      }
      return Reflect.apply(actual.writeFile, actual, args)
    }
  }
})

type UploadResult = { success: boolean; skillName?: string; error?: string }
type UploadHandler = (
  event: unknown,
  payload: { buffer: ArrayBuffer; fileName: string }
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
    const { commitCanonicalDisabledSkillMutation } = await import(
      "../skills/disabled-state-mutation"
    )
    const { DISABLED_SKILL_STORE_MISSING_FINGERPRINT } = await import(
      "../skills/disabled-store-fingerprint"
    )
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

  it("removes only a newly created partial directory when upload writing fails", async () => {
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
})
