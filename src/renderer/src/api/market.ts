import { MOCK_MARKET_DATA } from "../components/customize/MarketMockData"
import { toast } from "sonner"
import { getMockOrgSkillMarketResponse, orgSkillMarketApi } from "./org-skill-market"
import { USE_MARKET_MOCK_ON_ERROR } from "./market-flags"

export type MarketItemType = "skill" | "orgSkill" | "mcp" | "plugin"

export interface MarketListResponse {
  type: string
  items: MarketItem[]
}

export interface MarketUploadResponse {
  type: string
  name: string
  message: string
  s3_path: string
}

export interface MarketDeleteResponse {
  message: string
}

export interface MarketApiResponse {
  success: boolean
  data?: MarketItem[]
  error?: string
  pageNum?: number
  pageSize?: number
  total?: number
  pages?: number
  hasNextPage?: boolean
  hasPreviousPage?: boolean
}

export interface DownloadResponse {
  success: boolean
  error?: string
}

export interface DownloadedItemFile {
  blob: Blob
  filename: string
}

export interface MarketItem {
  name: string
  description: string
  filename: string
  created_at: string
  category?: string // Add category field
  tag?: string
  featured?: string // eg:官方推荐；精品；热门；个人；
  version?: string // eg:1.0.1
  user_id?: string // 110
  guidance?: string // Usage guidance for the skill/item
  chinese_name?: string // Chinese name for the skill/item
  // Only keep essential UI fields for compatibility
  id?: string
  type?: MarketItemType
  // Add field to track if user can delete this item
  canDelete?: boolean
  ip?: string
  installed?: boolean // 新增已安装状态字段
  installedVersion?: string
  updateAvailable?: boolean
  orgSkillId?: number
  orgSkillVersionId?: number
  sourceOriginName?: string
  managerName?: string
  managerDepartment?: string
  subscriptionCount?: number
}

export interface MarketUpdateResponse {
  type: string
  name: string
  message: string
  s3_path: string
}

function getMockMarketResponse(type: MarketItemType, error?: unknown): MarketApiResponse {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error")
  console.warn(`[marketApi] ${type} request failed, fallback to mock data. reason=${reason}`)
  return {
    success: true,
    data: MOCK_MARKET_DATA[type]
  }
}

// Updated API endpoints to match exact specification
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL + "/api/trajectories/marketplace" // Replace with actual API URL
const ENDPOINTS = {
  list: (resourceType: string) => `${API_BASE_URL}/list/${resourceType}`,
  upload: `${API_BASE_URL}/upload`,
  update: (resourceType: string, name: string) => `${API_BASE_URL}/${resourceType}/${name}`,
  download: (resourceType: string, name: string) =>
    `${API_BASE_URL}/download/${resourceType}/${name}`,
  delete: (resourceType: string, name: string) => `${API_BASE_URL}/${resourceType}/${name}`
}

function getErrorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null

  const payload = body as Record<string, unknown>
  const candidates = [payload.detail, payload.message, payload.error]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

async function readMarketErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP error! status: ${response.status}`

  try {
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      const data = await response.json()
      return getErrorMessageFromBody(data) || fallback
    }

    const text = await response.text()
    if (!text.trim()) return fallback

    try {
      const data = JSON.parse(text)
      return getErrorMessageFromBody(data) || text
    } catch {
      return text
    }
  } catch (error) {
    console.warn("[marketApi] Failed to parse error response:", error)
    return fallback
  }
}

async function throwMarketError(response: Response): Promise<never> {
  console.error(`API request failed: ${response.status} ${response.statusText}`)
  const message = await readMarketErrorMessage(response)
  console.error("Response error:", message)
  toast.error(message)
  throw new Error(message)
}

// Utility function to download blob as file
const downloadBlobAsFile = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Cache for API responses to prevent duplicate calls
interface CacheEntry {
  data: MarketApiResponse
  timestamp: number
}

const API_CACHE = new Map<string, CacheEntry>()

// Helper function to set cached data
const setCachedData = (key: string, data: MarketApiResponse): void => {
  API_CACHE.set(key, {
    data,
    timestamp: Date.now()
  })
}

// Updated API functions with caching
export const marketApi = {
  async fetchInstallFile(name: string, type: MarketItemType): Promise<DownloadedItemFile> {
    if (type === "orgSkill") {
      throw new Error("组织级技能下载需要 skillId 和 versionId")
    }

    console.log(`Fetching install file for ${type} item: ${name}`)
    const response = await fetch(ENDPOINTS.download(type, name), {
      method: "GET",
      headers: {
        Authorization: "Bearer your-api-token"
      }
    })

    if (!response.ok) {
      await throwMarketError(response)
    }

    const blob = await response.blob()
    const contentDisposition = response.headers.get("Content-Disposition")
    const defaultExt = type === "skill" || type === "plugin" ? "zip" : "json"
    const filename = contentDisposition?.match(/filename="([^"]+)"/)?.[1] || `${name}.${defaultExt}`

    return { blob, filename }
  },

  async fetchOrgSkillInstallFile(item: MarketItem): Promise<DownloadedItemFile> {
    return orgSkillMarketApi.fetchInstallFile(item)
  },

  async downloadLspVsix(): Promise<DownloadResponse> {
    try {
      if (typeof window.api?.lsp?.downloadVsix === "function") {
        const downloadResult = await window.api.lsp.downloadVsix()
        return {
          success: downloadResult.success,
          error: downloadResult.error
        }
      }

      return {
        success: false,
        error: "LSP VSIX download API is not available"
      }
    } catch (downloadError) {
      console.error("Failed to download LSP VSIX:", downloadError)
      return {
        success: false,
        error:
          downloadError instanceof Error ? downloadError.message : "Failed to download LSP VSIX"
      }
    }
  },

  async getSkills(): Promise<MarketApiResponse> {
    const cacheKey = "skills"

    // Check cache first
    // const cachedData = getCachedData(cacheKey)
    // if (cachedData) {
    //   return cachedData
    // }

    console.log("Fetching skills from API...")
    try {
      const response = await fetch(ENDPOINTS.list("skill"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        await throwMarketError(response)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error("Expected JSON but received:", responseText.substring(0, 200))
        throw new Error("Response is not JSON")
      }

      const data: MarketListResponse = await response.json()
      const result = {
        success: true,
        data: data.items || []
      }

      // Cache the result
      setCachedData(cacheKey, result)

      return result
    } catch (error) {
      console.error("Error fetching skills:", error)
      if (USE_MARKET_MOCK_ON_ERROR) {
        return getMockMarketResponse("skill", error)
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    }
  },

  async getMcps(): Promise<MarketApiResponse> {
    const cacheKey = "mcps"

    // Check cache first
    // const cachedData = getCachedData(cacheKey)
    // if (cachedData) {
    //   return cachedData
    // }

    console.log("Fetching MCPs from API...")
    try {
      const response = await fetch(ENDPOINTS.list("mcp"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        await throwMarketError(response)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error("Expected JSON but received:", responseText.substring(0, 200))
        throw new Error("Response is not JSON")
      }

      const data: MarketListResponse = await response.json()
      const result = {
        success: true,
        data: data.items || []
      }

      // Cache the result
      setCachedData(cacheKey, result)

      return result
    } catch (error) {
      console.error("Error fetching MCPs:", error)
      if (USE_MARKET_MOCK_ON_ERROR) {
        return getMockMarketResponse("mcp", error)
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    }
  },

  async getPlugins(): Promise<MarketApiResponse> {
    const cacheKey = "plugins"

    // Check cache first
    // const cachedData = getCachedData(cacheKey)
    // if (cachedData) {
    //   return cachedData
    // }

    console.log("Fetching plugins from API...")
    try {
      const response = await fetch(ENDPOINTS.list("plugin"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        await throwMarketError(response)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error("Expected JSON but received:", responseText.substring(0, 200))
        throw new Error("Response is not JSON")
      }

      const data: MarketListResponse = await response.json()
      const result = {
        success: true,
        data: data.items || []
      }

      // Cache the result
      setCachedData(cacheKey, result)

      return result
    } catch (error) {
      console.error("Error fetching plugins:", error)
      if (USE_MARKET_MOCK_ON_ERROR) {
        return getMockMarketResponse("plugin", error)
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    }
  },

  async getOrgSkills(
    pageNum = 1,
    pageSize = 10,
    labelIds: string[] = []
  ): Promise<MarketApiResponse> {
    console.log("Fetching organization skills from API...")
    try {
      return await orgSkillMarketApi.getOrgSkills(pageNum, pageSize, labelIds)
    } catch (error) {
      console.error("Error fetching organization skills:", error)
      if (USE_MARKET_MOCK_ON_ERROR) {
        const reason = error instanceof Error ? error.message : String(error ?? "unknown error")
        console.warn(`[marketApi] orgSkill request failed, fallback to mock data. reason=${reason}`)
        return getMockOrgSkillMarketResponse(pageNum, pageSize, labelIds)
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    }
  },

  async deleteItem(name: string, type: MarketItemType): Promise<MarketDeleteResponse> {
    console.log(`Deleting ${type} item: ${name}`)
    const response = await fetch(ENDPOINTS.delete(type, name), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer your-api-token"
      }
    })

    if (!response.ok) {
      await throwMarketError(response)
    }

    return await response.json()
  },

  async downloadItem(
    name: string,
    type: MarketItemType,
    downloadToLocal = false,
    _isFeatured = false,
    item?: MarketItem
  ): Promise<DownloadResponse> {
    void _isFeatured
    console.log(`Downloading ${type} item: ${name}`)
    const { blob, filename } =
      type === "orgSkill" && item
        ? await this.fetchOrgSkillInstallFile(item)
        : await this.fetchInstallFile(name, type)

    // If user wants to download to local file system
    if (downloadToLocal) {
      downloadBlobAsFile(blob, filename)
      return { success: true }
    }

    // For skills, we need to handle the downloaded file
    if (type === "skill" || type === "orgSkill") {
      try {
        const arrayBuffer = await blob.arrayBuffer()
        if (typeof window.api?.skills?.upload === "function") {
          const uploadResult = await window.api.skills.upload(arrayBuffer, filename)
          return {
            success: uploadResult.success,
            error: uploadResult.error
          }
        }
      } catch (uploadError) {
        console.error("Failed to upload downloaded skill:", uploadError)
        return {
          success: false,
          error: "Failed to save downloaded skill"
        }
      }
    }

    // For plugins, we need to handle the downloaded file similar to skills
    if (type === "plugin") {
      try {
        const arrayBuffer = await blob.arrayBuffer()
        if (typeof window.api?.plugins?.install === "function") {
          const installResult = await window.api.plugins.install(arrayBuffer, filename)
          return {
            success: installResult.success,
            error: installResult.error
          }
        }
      } catch (installError) {
        console.error("Failed to install downloaded plugin:", installError)
        return {
          success: false,
          error: "Failed to install downloaded plugin"
        }
      }
    }

    // For MCPs, handle JSON file content and add to system
    if (type === "mcp") {
      try {
        const text = await blob.text()
        const mcpConfig = JSON.parse(text)
        const serverEntries =
          mcpConfig?.mcpServers && typeof mcpConfig.mcpServers === "object"
            ? Object.entries(mcpConfig.mcpServers as Record<string, unknown>)
            : []
        const [serverName, serverConfig] = serverEntries[0] ?? [
          null,
          mcpConfig && typeof mcpConfig === "object" ? mcpConfig : null
        ]

        if (!serverConfig || typeof serverConfig !== "object") {
          return {
            success: false,
            error: "No valid MCP connectors found in configuration"
          }
        }

        const config = serverConfig as Record<string, unknown>
        const hasRemote = typeof config.url === "string" && config.url.trim().length > 0
        const hasStdio = typeof config.command === "string" && config.command.trim().length > 0

        if (!hasRemote && !hasStdio) {
          return {
            success: false,
            error: "No valid MCP connectors found in configuration"
          }
        }

        // Create all connectors
        if (typeof window.api?.mcp?.create === "function") {
          const advanced =
            config.advanced &&
            typeof config.advanced === "object" &&
            !Array.isArray(config.advanced)
              ? (config.advanced as Record<string, unknown>)
              : {}
          const resolvedTransport: "sse" | "streamable-http" | undefined =
            config.type === "sse" || config.type === "streamable-http"
              ? config.type
              : config.transport === "sse" || config.transport === "streamable-http"
                ? config.transport
                : advanced.transport === "sse" || advanced.transport === "streamable-http"
                  ? advanced.transport
                  : undefined
          const targetConfig = hasStdio
            ? {
                name:
                  (typeof config.name === "string" && config.name) ||
                  (typeof serverName === "string" && serverName) ||
                  name ||
                  "",
                kind: "stdio" as const,
                command: String(config.command),
                args:
                  Array.isArray(config.args) &&
                  config.args.every((arg): arg is string => typeof arg === "string")
                    ? config.args
                    : [],
                env:
                  config.env && typeof config.env === "object" && !Array.isArray(config.env)
                    ? Object.fromEntries(
                        Object.entries(config.env as Record<string, unknown>).filter(
                          (entry): entry is [string, string] => typeof entry[1] === "string"
                        )
                      )
                    : undefined,
                enabled: false
              }
            : {
                name:
                  (typeof config.name === "string" && config.name) ||
                  (typeof serverName === "string" && serverName) ||
                  name ||
                  "",
                kind: "remote" as const,
                url: String(config.url),
                enabled: false,
                advanced: {
                  ...advanced,
                  ...(resolvedTransport ? { transport: resolvedTransport } : {})
                }
              }
          await window.api.mcp.create(targetConfig)
          return {
            success: true
          }
        }
      } catch (parseError) {
        console.error("Failed to parse or install MCP connector:", parseError)
        return {
          success: false,
          error: "Failed to parse MCP configuration or install connector"
        }
      }
    }

    return { success: true }
  },

  async uploadFile(
    file: File,
    resourceType: string,
    name: string,
    description: string,
    category: string,
    guidance?: string,
    chineseName?: string,
    userId?: string
  ): Promise<{ success: boolean; data?: MarketUploadResponse; error?: string }> {
    console.log(`Uploading ${resourceType} file: ${file.name} category:${category}`)

    const formData = new FormData()
    formData.append("resource_type", resourceType)
    formData.append("name", name)
    formData.append("description", description)
    formData.append("file", file)
    formData.append("category", category)
    formData.append("version", "1.0.0") // Set default version to 1.0.0 for first upload
    if (guidance) {
      formData.append("guidance", guidance)
    }
    if (chineseName) {
      formData.append("chinese_name", chineseName)
    }
    if (userId) {
      formData.append("user_id", userId)
    }
    const ip = localStorage.getItem("localIp")
    formData.append("ip", ip || "")

    const response = await fetch(ENDPOINTS.upload, {
      method: "POST",
      headers: {
        Authorization: "Bearer your-api-token"
      },
      body: formData
    })

    if (!response.ok) {
      await throwMarketError(response)
    }

    const data: MarketUploadResponse = await response.json()
    return {
      success: true,
      data
    }
  },

  async updateItem(
    file: File | null,
    resourceType: string,
    name: string,
    description: string,
    category: string,
    guidance?: string,
    chineseName?: string,
    userId?: string
  ): Promise<{ success: boolean; data?: MarketUpdateResponse; error?: string }> {
    console.log(`Updating ${resourceType} item: ${name} category:${category}`)

    // First, get the current item to retrieve its version
    let currentVersion = "1.0.1" // Start from 1.0.1 for first update
    try {
      const currentItems = await this.getItemsByType(resourceType)
      const currentItem = currentItems.data?.find((item) => item.name === name)
      if (currentItem && currentItem.version) {
        currentVersion = this.incrementVersion(currentItem.version)
      }
    } catch (error) {
      console.warn("Could not retrieve current version, using default increment:", error)
    }

    const formData = new FormData()
    formData.append("resource_type", resourceType)
    formData.append("name", name)
    formData.append("description", description)
    if (file) {
      formData.append("file", file)
    }
    formData.append("category", category)
    formData.append("version", currentVersion) // Add auto-incremented version
    if (guidance) {
      formData.append("guidance", guidance)
    }
    if (chineseName) {
      formData.append("chinese_name", chineseName)
    }
    if (userId) {
      formData.append("user_id", userId)
    }
    const ip = localStorage.getItem("localIp")
    formData.append("ip", ip || "")

    console.log(`Auto-incrementing version to: ${currentVersion}`)

    const response = await fetch(ENDPOINTS.update(resourceType, name), {
      method: "PUT",
      headers: {
        Authorization: "Bearer your-api-token"
      },
      body: formData
    })

    if (!response.ok) {
      await throwMarketError(response)
    }

    const data: MarketUpdateResponse = await response.json()
    return {
      success: true,
      data
    }
  },

  // Helper method to increment version number
  incrementVersion(version: string): string {
    const versionParts = version.split(".")
    if (versionParts.length !== 3) {
      // Invalid version format, return default increment
      return "1.0.1"
    }

    const [major, minor, patch] = versionParts.map((part) => parseInt(part, 10))

    if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
      return "1.0.1"
    }

    // Increment patch version by 1
    return `${major}.${minor}.${patch + 1}`
  },

  // Helper method to get items by type (reusing existing logic)
  async getItemsByType(resourceType: string): Promise<MarketApiResponse> {
    switch (resourceType) {
      case "skill":
        return this.getSkills()
      case "mcp":
        return this.getMcps()
      case "plugin":
        return this.getPlugins()
      case "orgSkill":
        return this.getOrgSkills()
      default:
        throw new Error(`Unknown resource type: ${resourceType}`)
    }
  }
}
