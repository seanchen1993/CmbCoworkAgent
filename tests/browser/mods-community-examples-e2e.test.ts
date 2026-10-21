import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { afterEach, expect, it, vi } from "vitest"
import { mirrorBundledModExamples } from "../../src/main/build/bundled-mod-examples"
import {
  BUNDLED_EXAMPLES,
  verifyCommunityExample,
  withMaterializedCommunityExample
} from "../../src/main/mods/community-examples"
import {
  PACKAGED_COMMUNITY_EXAMPLE_IDS,
  verifyPackagedCommunityExamples
} from "../support/mods-community-examples-e2e"

const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const directory of temporary.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
    expect(directory).toContain("community-helper-test-")
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(failedExample = "") {
  const directory = await mkdtemp(join(tmpdir(), "community-helper-test-"))
  temporary.push(directory)
  const data = join(directory, "data"),
    workspace = join(directory, "Workspace")
  const archiveContents = join(directory, "bundled-mods")
  await mkdir(data)
  await mkdir(workspace)
  await mirrorBundledModExamples(resolve("."), archiveContents)
  const source = join(archiveContents, "community-originals")
  type Row = { id: string; name: string; path: string; version: string; updatedAt: number }
  const baseline: Row = {
    id: "unrelated",
    name: "unrelated",
    path: "unused",
    version: "1",
    updatedAt: 1
  }
  let rows: Row[] = [baseline],
    sequence = 0
  const approve = vi.fn(),
    removeThread = vi.fn(async () => {})
  let canonicalWorkspace = ""
  const api = {
    threads: { create: async () => ({ thread_id: "community-thread" }), delete: removeThread },
    workspace: { set: async (_id: string, path: string) => {
      canonicalWorkspace = path.toLowerCase()
    } },
    mods: {
      globalEnabled: async () => true,
      configure: vi.fn(async (_id: string, _enabled: boolean, _policy: boolean, expected: string) => {
        expect(expected).toBe(canonicalWorkspace)
      }),
      approveFunction: approve,
      status: async () => ({
        workspace: canonicalWorkspace,
        functionMods: rows
          .filter((row) => row.id !== baseline.id)
          .map((row) => ({
            pluginId: row.id,
            name: row.name,
            state: "needs-approval",
            digest: createHash("sha256").update(row.id).digest("hex")
          }))
      }),
      communityExamples: {
        list: async () => ({
          examples: await Promise.all(
            BUNDLED_EXAMPLES.map(async (example) => {
              const row = rows.find((row) => row.name === example.pluginName)
              if (!row) return { ...example, installation: { state: "missing" } }
              try {
                await verifyCommunityExample(source, example.id, row.path)
                return { ...example, installation: { state: "installed", pluginId: row.id } }
              } catch {
                return { ...example, installation: { state: "conflict" } }
              }
            })
          )
        }),
        install: vi.fn(async ({ exampleId }: { exampleId: string }) => {
          if (failedExample === exampleId) throw Error("MODS_COMMUNITY_INTEGRITY")
          const example = BUNDLED_EXAMPLES.find((example) => example.id === exampleId)!
          const existing = rows.find((row) => row.name === example.pluginName)
          if (existing) {
            try {
              await verifyCommunityExample(source, example.id, existing.path)
            } catch {
              throw Error("MODS_COMMUNITY_EXISTING_CONFLICT")
            }
            return {
              pluginId: existing.id,
              pluginName: example.pluginName,
              alreadyInstalled: true,
              requiresApproval: true
            }
          }
          const row = {
            id: `created-${++sequence}`,
            name: example.pluginName,
            path: join(data, "plugins", example.pluginName),
            version: "1",
            updatedAt: 1
          }
          await withMaterializedCommunityExample(source, example.id, async (staged) => {
            await cp(staged, row.path, { recursive: true })
          })
          rows.push(row)
          return {
            pluginId: row.id,
            pluginName: row.name,
            alreadyInstalled: false,
            requiresApproval: true
          }
        })
      }
    },
    plugins: {
      list: async () => structuredClone(rows),
      delete: vi.fn(async (id: string) => {
        const row = rows.find((row) => row.id === id)!
        expect(row.id).not.toBe(baseline.id)
        await rm(row.path, { recursive: true, force: true })
        rows = rows.filter((row) => row.id !== id)
        return { success: true }
      }),
      install: vi.fn(async (buffer: ArrayBuffer) => {
        const row = rows.find((row) => row.name === "token-weather")!
        for (const entry of new AdmZip(Buffer.from(buffer)).getEntries()) {
          const target = join(row.path, entry.entryName)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, entry.getData())
        }
        row.updatedAt++
        return { success: true, pluginId: row.id }
      })
    }
  }
  vi.stubGlobal("window", { api })
  const page = {
    evaluate: async <T, A>(fn: (value: A) => T, value: A) => await fn(value)
  } as unknown as Page
  const artifacts = join(directory, "artifacts")
  const run = () =>
    verifyPackagedCommunityExamples(
      page,
      workspace,
      data,
      artifacts,
      async (check) => {
        expect(await check()).toBe(true)
      },
      () => {}
    )
  return { api, artifacts, run, baseline, rows: () => rows }
}

it("uses public IPC for nine installs, unapproved idempotence and a preserved personal ZIP conflict", async () => {
  const f = await fixture()
  await f.run()
  expect(f.api.mods.communityExamples.install).toHaveBeenCalledTimes(19)
  expect(f.api.plugins.install).toHaveBeenCalledOnce()
  expect(f.api.mods.approveFunction).not.toHaveBeenCalled()
  expect(f.api.mods.configure).toHaveBeenCalledOnce()
  expect(f.api.plugins.delete).toHaveBeenCalledTimes(9)
  expect(f.api.threads.delete).toHaveBeenCalledWith("community-thread")
  expect(f.rows()).toEqual([f.baseline])
  const evidence = JSON.parse(
    await readFile(join(f.artifacts, "packaged-community-examples.json"), "utf8")
  )
  expect(evidence).toMatchObject({
    complete: true,
    errorCount: 0,
    exampleIds: PACKAGED_COMMUNITY_EXAMPLE_IDS
  })
  expect(evidence.checks).toHaveLength(3)
})

it("fails on real installation failure and cleans only the packages it successfully created", async () => {
  const f = await fixture("task-behavior-prefix")
  await expect(f.run()).rejects.toThrow("Packaged community example acceptance failed")
  expect(f.api.mods.approveFunction).not.toHaveBeenCalled()
  expect(f.api.plugins.delete).toHaveBeenCalledTimes(2)
  expect(f.rows()).toEqual([f.baseline])
  const evidence = JSON.parse(
    await readFile(join(f.artifacts, "packaged-community-examples.json"), "utf8")
  )
  expect(evidence).toMatchObject({ complete: false, errorCount: 1 })
})

it("retains the installation failure when evidence cannot be written after cleanup", async () => {
  const f = await fixture("task-behavior-prefix")
  await mkdir(join(f.artifacts, "packaged-community-examples.json"), { recursive: true })
  const error = await f.run().catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(AggregateError)
  const failures = (error as AggregateError).errors
  expect(failures).toHaveLength(2)
  expect(failures[0]).toMatchObject({ message: "MODS_COMMUNITY_INTEGRITY" })
  expect(failures[1]).toBeInstanceOf(Error)
  expect(f.api.plugins.delete).toHaveBeenCalledTimes(2)
  expect(f.rows()).toEqual([f.baseline])
  expect(f.api.mods.approveFunction).not.toHaveBeenCalled()
})
