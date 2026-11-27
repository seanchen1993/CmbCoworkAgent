import { describe, expect, it } from "vitest"
import {
  canCurrentUserViewMarketItem,
  getMarketViewerIdCandidates,
  type MarketViewerIdentity
} from "@/lib/market-visibility"
import type { PluginMetadata } from "@/types"
import type {
  HarnessAdapterRegistryItem,
  HarnessProjectListItem
} from "../../../../shared/harness-board-types"
import type { MarketItem } from "../../api/market"
import {
  filterProjectDialogInstalledAdapters,
  findMarketPluginForAdapter,
  findSelectedAdapter
} from "./project-dialog-plugin-visibility"

const marketItem = (name: string, fields: Partial<MarketItem> = {}): MarketItem => ({
  name,
  filename: `${name}.zip`,
  description: "",
  created_at: "",
  ...fields
})

const grayPlugin = marketItem("gray-market", {
  id: "gray-market-id",
  user_id: "777777",
  extra_json: JSON.stringify({ grayUserIds: ["123456"], grayOrgs: ["研发一室"] })
})
const publicPlugin = marketItem("public-market")

const visibleFor = (items: MarketItem[], user: MarketViewerIdentity | null): MarketItem[] => {
  const candidates = getMarketViewerIdCandidates(user)
  return items.filter((item) =>
    canCurrentUserViewMarketItem(item, user?.sapId, candidates, user?.pathName)
  )
}

const plugin = (id: string, fields: Partial<PluginMetadata> = {}): PluginMetadata => ({
  id,
  name: id,
  author: "",
  path: `/plugins/${id}`,
  version: "1.0.0",
  description: "",
  enabled: true,
  skillCount: 0,
  mcpServerCount: 0,
  createdAt: "",
  updatedAt: "",
  ...fields
})

const adapter = (installed: PluginMetadata): HarnessAdapterRegistryItem => ({
  id: installed.id,
  name: installed.name,
  version: installed.version,
  type: "plugin",
  description: "",
  boardCompatibility: { status: "compatible", compatible: true, appApiVersion: 1, label: "" }
})

describe("market visibility for project dialogs", () => {
  it.each([{ sapId: "80777777" }, { ystId: "123456" }, { pathName: "总行/研发一室/平台团队" }])(
    "applies the same uploader, user ID and organization rules for %j",
    (user) => {
      expect(visibleFor([grayPlugin, publicPlugin], user)).toEqual([grayPlugin, publicPlugin])
    }
  )

  it("requires a gray match, but shows public entries without user info", () => {
    const unrelated = { sapId: "999999", pathName: "总行/研发二室" }
    expect(visibleFor([grayPlugin, publicPlugin], unrelated)).toEqual([publicPlugin])
    expect(visibleFor([grayPlugin, publicPlugin], null)).toEqual([publicPlugin])
  })

  it("filters installed market plugins by marketplace identity and keeps local imports", () => {
    const installedGray = plugin("gray-manifest", {
      origin: "market",
      sourceAccess: "whitelist",
      marketplace: { name: "old-market-name", id: grayPlugin.id }
    })
    const installedPublic = plugin(publicPlugin.name, { origin: "market" })
    const local = plugin("local-copy", { name: grayPlugin.name, origin: "local" })
    const installed = [local, installedGray, installedPublic]
    const registry = installed.map(adapter)
    const listings = [grayPlugin, publicPlugin]
    const visible = visibleFor(listings, null)

    expect(filterProjectDialogInstalledAdapters(registry, installed, listings, visible)).toEqual([
      adapter(local),
      adapter(installedPublic)
    ])
    expect(filterProjectDialogInstalledAdapters(registry, installed, listings, listings)).toEqual(
      registry
    )
    expect(filterProjectDialogInstalledAdapters(registry, installed, [], [])).toEqual([
      adapter(local)
    ])
  })

  it("keeps a hidden binding as the edited project's current value only", () => {
    const bound = adapter(plugin("hidden-binding"))
    const replacement = adapter(plugin("public-replacement"))
    const project: Pick<
      HarnessProjectListItem,
      "harnessAdapter" | "boardCompatibility" | "supportsKnowledgeBaseContext"
    > = {
      harnessAdapter: { id: bound.id, name: bound.name, type: "plugin" },
      boardCompatibility: bound.boardCompatibility,
      supportsKnowledgeBaseContext: true
    }

    expect(findSelectedAdapter([replacement], bound.id, project)).toMatchObject({
      id: bound.id,
      name: bound.name,
      supportsKnowledgeBaseContext: true
    })
    expect(findSelectedAdapter([replacement], replacement.id, project)).toBe(replacement)
    expect(findSelectedAdapter([replacement], bound.id)).toBeNull()
  })

  it("matches market metadata for market plugins even when the user has source access, but skips local imports", () => {
    const marketListing = marketItem("AutoBizDevOps_Scene_Lite", {
      id: "scene-lite-id",
      category: "研发类场景/应用类研发",
      description: "轻量开发交付闭环"
    })
    const ownerInstalled = plugin("installed-owner", {
      name: "AutoBizDevOps_Scene_Lite",
      origin: "market",
      sourceAccess: "owner",
      marketplace: { name: marketListing.name, id: marketListing.id }
    })
    const whitelistInstalled = plugin("installed-whitelist", {
      name: "AutoBizDevOps_Scene_Lite",
      origin: "market",
      sourceAccess: "whitelist",
      marketplace: { name: marketListing.name, id: marketListing.id }
    })
    const regularInstalled = plugin("installed-regular", {
      name: "AutoBizDevOps_Scene_Lite",
      origin: "market",
      marketplace: { name: marketListing.name, id: marketListing.id }
    })
    const localInstalled = plugin("installed-local", {
      name: "AutoBizDevOps_Scene_Lite",
      origin: "local"
    })

    expect(
      findMarketPluginForAdapter([marketListing], ownerInstalled, adapter(ownerInstalled))
    ).toBe(marketListing)
    expect(
      findMarketPluginForAdapter([marketListing], whitelistInstalled, adapter(whitelistInstalled))
    ).toBe(marketListing)
    expect(
      findMarketPluginForAdapter([marketListing], regularInstalled, adapter(regularInstalled))
    ).toBe(marketListing)
    expect(
      findMarketPluginForAdapter([marketListing], localInstalled, adapter(localInstalled))
    ).toBeUndefined()
    expect(
      findMarketPluginForAdapter([marketListing], undefined, adapter(regularInstalled))
    ).toBe(marketListing)
  })
})
