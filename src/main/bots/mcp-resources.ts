import { createHash } from "node:crypto"
import { UriTemplate, type Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import { z } from "zod"
import type { CapabilitySource, ManagedMcpCapabilityService } from "../mcp/capability-core"
import { BotDomainError } from "../../shared/bot-types"
import { canonicalJson } from "./validation"

const common = {
  name: z.string().max(512),
  title: z.string().max(512).optional(),
  description: z.string().max(32_000).optional(),
  mimeType: z.string().max(256).optional()
}
const resource = z.object({ ...common, uri: z.string().min(1).max(8192) })
const template = z.object({ ...common, uriTemplate: z.string().min(1).max(8192) })
export type BotMcpResource = (z.infer<typeof resource> | z.infer<typeof template>) & {
  id: string
  provider: string
  kind: "resources" | "templates"
}
type ResourceService = Pick<ManagedMcpCapabilityService, "resourceProvider" | "listResources">
type Catalog = { generation: string; entries: BotMcpResource[]; bytes: number }
const catalogLimit = 4 * 1024 * 1024

/** Uses the existing negotiated Cmb MCP clients. Opaque IDs bind the provider,
 * configuration and complete advertised resource, never a model-supplied URI.
 * A catalog is committed only after all pages pass validation and scope checks. */
export class BotMcpResources {
  private readonly catalogs = new Map<string, Catalog>()
  private readonly pending = new Map<string, Promise<BotMcpResource[]>>()

  constructor(
    private readonly service: ResourceService,
    private readonly sources: CapabilitySource[],
    private readonly configuration: string,
    private readonly current: () => Promise<void>
  ) {}

  providers() {
    return this.sources.map(({ providerKey, providerDisplayName }) => ({
      id: providerKey,
      name: providerDisplayName
    }))
  }

  async list(provider: string, kind: "resources" | "templates"): Promise<BotMcpResource[]> {
    await this.current()
    if (!this.sources.some((source) => source.providerKey === provider))
      throw new BotDomainError("connector_missing", "连接器不存在或未授权")
    const key = canonicalJson([provider, kind])
    const active = this.pending.get(key)
    if (active) return active
    const load = this.load(provider, kind, key)
    this.pending.set(key, load)
    try {
      return await load
    } finally {
      if (this.pending.get(key) === load) this.pending.delete(key)
    }
  }

  private async load(provider: string, kind: "resources" | "templates", key: string) {
    const connection = await this.service.resourceProvider(provider)
    await this.current()
    const cached = this.catalogs.get(key)
    if (cached?.generation === connection.connectionGeneration) return cached.entries
    const entries: BotMcpResource[] = []
    const seenCursors = new Set<string>(),
      seenEntries = new Set<string>()
    let cursor: string | undefined,
      bytes = 0
    const fail = () =>
      new BotDomainError(
        "resource_catalog_limit",
        "资源目录超出大小或分页限制，请缩小连接器提供的目录"
      )
    do {
      await this.current()
      const page = await this.service.listResources(provider, kind, cursor, {
        expectedConnectionGeneration: connection.connectionGeneration
      })
      await this.current()
      bytes += Buffer.byteLength(JSON.stringify(page))
      if (bytes > catalogLimit) throw fail()
      const parsed = (
        kind === "resources"
          ? z.object({
              resources: z.array(resource).max(20_000),
              nextCursor: z.string().min(1).max(16_384).optional()
            })
          : z.object({
              resourceTemplates: z.array(template).max(20_000),
              nextCursor: z.string().min(1).max(16_384).optional()
            })
      ).parse(page)
      const items = "resources" in parsed ? parsed.resources : parsed.resourceTemplates
      for (const item of items) {
        const identity = canonicalJson([this.configuration, provider, kind, item])
        const id = createHash("sha256").update(identity).digest("hex")
        if (seenEntries.has(id)) continue
        seenEntries.add(id)
        entries.push({ ...item, id, provider, kind })
        if (entries.length > 20_000) throw fail()
      }
      cursor = parsed.nextCursor
      if (cursor) {
        if (seenCursors.has(cursor) || seenCursors.size >= 100) throw fail()
        seenCursors.add(cursor)
      }
    } while (cursor)
    const retained = [...this.catalogs.entries()].reduce(
      (sum, [id, value]) => (id === key ? sum : sum + value.bytes),
      0
    )
    if (retained + bytes > catalogLimit) throw fail()
    this.catalogs.set(key, { generation: connection.connectionGeneration, entries, bytes })
    return entries
  }

  async resolve(
    provider: string,
    kind: "resources" | "templates",
    id: string,
    variables: Variables
  ) {
    const target = (await this.list(provider, kind)).find((entry) => entry.id === id)
    if (!target)
      throw new BotDomainError("resource_missing", "资源目录已变化或资源不存在，请重新查询")
    if ("uri" in target) {
      if (Object.keys(variables).length)
        throw new BotDomainError("resource_parameters", "固定资源不接受模板参数")
      return { target, uri: target.uri }
    }
    const parsed = new UriTemplate(target.uriTemplate)
    const names = new Set(parsed.variableNames)
    if (
      Object.keys(variables).some(
        (key) => !names.has(key) || ["__proto__", "prototype", "constructor"].includes(key)
      )
    )
      throw new BotDomainError("resource_parameters", "参数不属于此资源模板")
    // The installed MCP SDK implements the server's URI-template contract,
    // including optional query variables and percent encoding.
    const uri = parsed.expand(variables)
    if (!uri || uri.length > 8192)
      throw new BotDomainError("resource_uri_limit", "资源地址为空或过长")
    return { target, uri }
  }
}

const resourceContent = z
  .object({
    uri: z.string().min(1).max(8192),
    mimeType: z.string().max(256).optional(),
    text: z.string().optional(),
    blob: z.string().optional()
  })
  .refine(
    (value) => (value.text !== undefined) !== (value.blob !== undefined),
    "Resource must contain text or a binary blob"
  )

/** Keep content in one bounded projection before publication. Binary content
 * uses the existing policy's base64 field, so protected output cannot leak it. */
export function botResourceContents(value: unknown) {
  const parsed = z.object({ contents: z.array(resourceContent).max(1000) }).parse(value)
  if (Buffer.byteLength(JSON.stringify(parsed)) > 400_000)
    throw new BotDomainError(
      "resource_result_limit",
      "资源内容过大，请使用连接器提供的分页或分段资源"
    )
  return {
    contents: parsed.contents.map(({ blob, ...content }) => ({
      ...content,
      ...(blob !== undefined ? { base64: blob } : {})
    }))
  }
}
