import { expect, it, vi } from "vitest"
import type { CapabilitySource, ManagedMcpCapabilityService } from "../mcp/capability-core"
import { BotMcpResources, botResourceContents } from "./mcp-resources"

const source: CapabilitySource = {
  providerKey: "notes",
  providerDisplayName: "Notes",
  kind: "connector",
  scope: "global",
  visibility: "lazy",
  priority: 1,
  serverConfig: { apiKey: "never-in-catalog" }
}
function fixture() {
  let generation = "one"
  const service = {
    resourceProvider: vi.fn(async () => ({
      providerKey: "notes",
      providerDisplayName: "Notes",
      connectionGeneration: generation
    })),
    listResources: vi.fn<ManagedMcpCapabilityService["listResources"]>(
      async (_provider, kind, cursor) =>
        kind === "templates"
          ? { resourceTemplates: [{ name: "Notes", uriTemplate: "notes://project/{project}{?q}" }] }
          : cursor
            ? { resources: [{ name: "Second", uri: "notes://second" }] }
            : { resources: [{ name: "First", uri: "notes://first" }], nextCursor: "page2" }
    )
  }
  const current = vi.fn(async () => {})
  return {
    service,
    current,
    catalog: new BotMcpResources(service, [source], "configuration", current),
    reconnect: () => {
      generation = "two"
    }
  }
}

it("collects paginated resources, preserves provider scope, and invalidates a reconnected catalog", async () => {
  const f = fixture()
  expect(JSON.stringify(f.catalog.providers())).not.toContain("never-in-catalog")
  await expect(f.catalog.list("ungranted", "resources")).rejects.toThrow("未授权")
  expect(f.service.resourceProvider).not.toHaveBeenCalled()
  const entries = await f.catalog.list("notes", "resources")
  expect(entries.map((entry) => entry.name)).toEqual(["First", "Second"])
  expect(
    f.service.listResources.mock.calls.map((call) => [
      call[2],
      call[3]?.expectedConnectionGeneration
    ])
  ).toEqual([
    [undefined, "one"],
    ["page2", "one"]
  ])
  await f.catalog.list("notes", "resources")
  expect(f.service.listResources).toHaveBeenCalledTimes(2)
  f.reconnect()
  expect(await f.catalog.list("notes", "resources")).toEqual(entries)
  expect(f.service.listResources).toHaveBeenCalledTimes(4)
  await expect(
    f.catalog.resolve("notes", "resources", entries[0].id, { q: "bad" })
  ).rejects.toThrow("固定资源")
  await expect(f.catalog.resolve("notes", "resources", "made-up", {})).rejects.toThrow("不存在")
})

it("expands only an advertised template using the installed SDK, including optional queries and escaped values", async () => {
  const f = fixture()
  const [target] = await f.catalog.list("notes", "templates")
  expect(
    (
      await f.catalog.resolve("notes", "templates", target.id, {
        project: "a/b 中文",
        q: "test & more"
      })
    ).uri
  ).toBe("notes://project/a%2Fb%20%E4%B8%AD%E6%96%87?q=test%20%26%20more")
  expect((await f.catalog.resolve("notes", "templates", target.id, { project: "a" })).uri).toBe(
    "notes://project/a"
  )
  await expect(
    f.catalog.resolve("notes", "templates", target.id, { project: "a", inject: "bad" })
  ).rejects.toThrow("不属于")
  await expect(
    f.catalog.resolve("notes", "templates", target.id, JSON.parse('{"__proto__":"bad"}'))
  ).rejects.toThrow("不属于")
  const other = new BotMcpResources(f.service, [source], "changed-configuration", f.current)
  expect((await other.list("notes", "templates"))[0].id).not.toBe(target.id)
})

it("rejects cyclic pages and revocation without publishing a partial catalog", async () => {
  const f = fixture()
  f.service.listResources.mockResolvedValue({
    resources: [{ uri: "notes://first", name: "First" }],
    nextCursor: "cycle"
  })
  await expect(f.catalog.list("notes", "resources")).rejects.toThrow("分页限制")
  expect(f.service.listResources).toHaveBeenCalledTimes(2)
  f.service.listResources.mockResolvedValue({
    resources: [{ uri: "notes://first", name: "First" }]
  })
  f.current.mockRejectedValueOnce(new Error("revoked"))
  await expect(f.catalog.list("notes", "resources")).rejects.toThrow("revoked")
  expect(await f.catalog.list("notes", "resources")).toHaveLength(1)
  expect(f.service.listResources).toHaveBeenCalledTimes(3)
})

it("keeps text and binary payloads explicit for publication and rejects ambiguous or oversized content", () => {
  expect(
    botResourceContents({
      contents: [
        { uri: "notes://empty", text: "", mimeType: "text/plain" },
        { uri: "notes://binary", blob: "AQID", mimeType: "application/octet-stream" }
      ]
    })
  ).toEqual({
    contents: [
      { uri: "notes://empty", text: "", mimeType: "text/plain" },
      { uri: "notes://binary", base64: "AQID", mimeType: "application/octet-stream" }
    ]
  })
  for (const contents of [
    [{ uri: "notes://bad" }],
    [{ uri: "notes://bad", text: "", blob: "" }],
    [{ uri: "notes://big", text: "a".repeat(400_000) }]
  ])
    expect(() => botResourceContents({ contents })).toThrow()
})
