import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  knowledgeDirectory,
  mergeCloudKnowledgeState,
  parseCloudKnowledgeItems,
  readKnowledgeState,
  writeKnowledgeState
} from "./knowledge-base-state"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-state-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const cloud = (idKey: string) => ({
  idKey,
  name: idKey,
  description: "description",
  ownerId: "",
  ownerName: "",
  repoUrl: "https://example.com/repo.git",
  sshUrl: null,
  gitRef: "main"
})

describe("knowledge cloud state", () => {
  it("accepts server-filtered items without organization rules and assigns public type", () => {
    const state = mergeCloudKnowledgeState(null, parseCloudKnowledgeItems([cloud("one")]))
    expect(state).toEqual({
      schemaVersion: 1,
      knowledgeBases: [
        {
          ...cloud("one"),
          type: "public",
          visibility: "visible",
          workspaces: [
            { role: "read", status: "not_downloaded", lastError: null },
            { role: "write", status: "not_downloaded", lastError: null }
          ]
        }
      ]
    })
    expect(knowledgeDirectory("one", "read")).not.toBe(knowledgeDirectory("one", "write"))
  })

  it("marks missing records unavailable, preserves type and state, and restores visibility", () => {
    const previous = mergeCloudKnowledgeState(null, [cloud("one")])
    previous.knowledgeBases[0].workspaces[0].status = "success"
    const absent = mergeCloudKnowledgeState(previous, [])
    expect(absent.knowledgeBases[0]).toMatchObject({ visibility: "unavailable", type: "public" })
    const restored = mergeCloudKnowledgeState(absent, [cloud("one")])
    expect(restored.knowledgeBases[0].visibility).toBe("visible")
    expect(restored.knowledgeBases[0].workspaces[0].status).toBe("success")
  })

  it("invalidates success only for changed repository or branch, not a renamed library", () => {
    const previous = mergeCloudKnowledgeState(null, [cloud("one")])
    previous.knowledgeBases[0].workspaces.forEach((entry) => {
      entry.status = "success"
    })
    const renamed = mergeCloudKnowledgeState(previous, [{ ...cloud("one"), name: "new name" }])
    expect(renamed.knowledgeBases[0].workspaces.every((entry) => entry.status === "success")).toBe(
      true
    )
    for (const changed of [{ gitRef: "release" }, { repoUrl: "https://example.com/new.git" }]) {
      const next = mergeCloudKnowledgeState(previous, [{ ...cloud("one"), ...changed }])
      expect(
        next.knowledgeBases[0].workspaces.every((entry) => entry.status === "not_downloaded")
      ).toBe(true)
    }
  })

  it("reads workspace arrays by role and rejects duplicate or missing roles without adapting old state", async () => {
    const state = mergeCloudKnowledgeState(null, [cloud("one")])
    state.knowledgeBases[0].workspaces.reverse()
    await writeKnowledgeState(state)
    expect(
      (await readKnowledgeState())?.knowledgeBases[0].workspaces.map((entry) => entry.role)
    ).toEqual(["read", "write"])
    state.knowledgeBases[0].workspaces[1].role = "write"
    await writeKnowledgeState(state)
    await expect(readKnowledgeState()).rejects.toThrow("状态无效")
  })

  it("normalizes blank refs and rejects duplicate ids", () => {
    expect(parseCloudKnowledgeItems([{ ...cloud("one"), gitRef: " " }])[0].gitRef).toBe("main")
    expect(() => parseCloudKnowledgeItems([cloud("one"), cloud("one")])).toThrow("重复")
  })

  it.each([
    { name: " name " },
    { name: "" },
    { gitRef: 42 },
    { sshUrl: {} },
    { description: 42 },
    { repoUrl: "--invalid-source" },
    { repoUrl: "https://" },
    { repoUrl: "ext::command" },
    { sshUrl: "not-a-git-url" },
    { idKey: "../escape" },
    { idKey: "back\\slash" }
  ])("rejects invalid configuration without normalizing names: %j", (invalid) => {
    expect(() => parseCloudKnowledgeItems([{ ...cloud("one"), ...invalid }])).toThrow()
  })

  it("preserves names and accepts SSH repository addresses", () => {
    expect(
      parseCloudKnowledgeItems([
        {
          ...cloud("one"),
          name: "知识库 A",
          repoUrl: "ssh://git@git.example.test/knowledge.git",
          sshUrl: "git@git.example.test:knowledge.git"
        }
      ])[0].name
    ).toBe("知识库 A")
  })
})

describe("knowledge library success time", () => {
  it("retains the recorded time across cloud refresh, source changes, disappearance and recovery", async () => {
    const initial = mergeCloudKnowledgeState(null, [cloud("one")])
    initial.knowledgeBases[0].lastSuccessfulSyncAt = "2026-10-21 10:00:00"
    await writeKnowledgeState(initial)
    const stored = await readKnowledgeState()
    for (const items of [[], [cloud("one")], [{ ...cloud("one"), gitRef: "release" }]]) {
      const next = mergeCloudKnowledgeState(stored, items)
      expect(next.knowledgeBases[0].lastSuccessfulSyncAt).toBe("2026-10-21 10:00:00")
    }
  })

  it("does not invent a success time for a new library and rejects non-GMT+8 text formats", async () => {
    const state = mergeCloudKnowledgeState(null, [cloud("one")])
    expect(state.knowledgeBases[0].lastSuccessfulSyncAt).toBeUndefined()
    state.knowledgeBases[0].lastSuccessfulSyncAt = "2026-10-21T02:00:00Z"
    await writeKnowledgeState(state)
    await expect(readKnowledgeState()).rejects.toThrow("本地状态无效")
  })
})

describe("knowledge maintainers", () => {
  it("persists cloud owner fields, refreshes them, and retains them for unavailable libraries", async () => {
    const source = { ...cloud("one"), ownerName: "测试维护人", ownerId: "12345" }
    const state = mergeCloudKnowledgeState(null, parseCloudKnowledgeItems([source]))
    await writeKnowledgeState(state)
    expect((await readKnowledgeState())!.knowledgeBases[0]).toMatchObject({
      ownerName: "测试维护人",
      ownerId: "12345"
    })
    const changed = mergeCloudKnowledgeState(state, [
      { ...source, ownerName: "新维护人", ownerId: "67890" }
    ])
    expect(changed.knowledgeBases[0]).toMatchObject({ ownerName: "新维护人", ownerId: "67890" })
    expect(mergeCloudKnowledgeState(changed, []).knowledgeBases[0]).toMatchObject({
      visibility: "unavailable",
      ownerName: "新维护人",
      ownerId: "67890"
    })
  })

  it("accepts absent maintainer fields as empty values", () => {
    const source: Record<string, unknown> = { ...cloud("one") }
    delete source.ownerId
    delete source.ownerName
    expect(parseCloudKnowledgeItems([source])[0]).toMatchObject({ ownerName: "", ownerId: "" })
    expect(parseCloudKnowledgeItems([{ ...source, ownerName: "只有姓名" }])[0]).toMatchObject({
      ownerName: "只有姓名",
      ownerId: ""
    })
    expect(parseCloudKnowledgeItems([{ ...source, ownerId: "12345" }])[0]).toMatchObject({
      ownerName: "",
      ownerId: "12345"
    })
  })

  it.each([
    { ownerId: 42 },
    { ownerName: {} },
    { ownerId: "x".repeat(33) },
    { ownerName: "x".repeat(65) }
  ])("rejects invalid owner fields: %j", (invalid) => {
    expect(() => parseCloudKnowledgeItems([{ ...cloud("one"), ...invalid }])).toThrow()
  })
})
