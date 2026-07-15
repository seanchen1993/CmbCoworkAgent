import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { getOpenworkDir } from "../storage"

export const UPDATE_CHANNEL_CONFIG_FILE = "update-channel.json"
export const DEFAULT_UPDATE_MANIFEST_FILE = "cmbdevclaw-latest.json"
export const DEFAULT_SELFTEST_MANIFEST_FILE = "cmbdevclaw-latest.selftest.json"

export type UpdateSourceChannel = "production" | "selftest"

export interface UpdateSourceInfo {
  channel: UpdateSourceChannel
  baseUrl: string
  manifestFile: string
  configPath?: string
  expiresAt?: string
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function makeProductionSource(defaultBaseUrl: string): UpdateSourceInfo {
  return {
    channel: "production",
    baseUrl: normalizeBaseUrl(defaultBaseUrl),
    manifestFile: DEFAULT_UPDATE_MANIFEST_FILE
  }
}

function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isSafeSelfTestManifestFile(value: string): boolean {
  if (value === DEFAULT_UPDATE_MANIFEST_FILE) return false
  return /^cmbdevclaw-latest(?:[.-][A-Za-z0-9_.-]+)?\.json$/.test(value)
}

function readStringField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getUpdateChannelConfigPath(): string {
  return join(getOpenworkDir(), UPDATE_CHANNEL_CONFIG_FILE)
}

export function resolveUpdateSourceFromConfig(
  rawConfig: unknown,
  defaultBaseUrl: string,
  options: { configPath?: string; now?: Date } = {}
): UpdateSourceInfo {
  const fallback = makeProductionSource(defaultBaseUrl)
  if (!rawConfig || typeof rawConfig !== "object") return fallback

  const raw = rawConfig as Record<string, unknown>
  if (raw.enabled !== true) return fallback

  if (raw.channel !== "selftest") {
    console.warn('[Updater] Ignoring update-channel.json: channel must be "selftest"')
    return fallback
  }

  const expiresAt = readStringField(raw, "expiresAt")
  if (expiresAt) {
    const expiresAtTime = Date.parse(expiresAt)
    if (Number.isNaN(expiresAtTime)) {
      console.warn("[Updater] Ignoring selftest update source: expiresAt is invalid")
      return fallback
    }
    if (expiresAtTime <= (options.now ?? new Date()).getTime()) {
      console.warn("[Updater] Ignoring selftest update source: config has expired")
      return fallback
    }
  } else {
    console.warn(
      "[Updater] Selftest update source has no expiresAt; remember to disable it after testing"
    )
  }

  const manifestFile = readStringField(raw, "manifestFile") ?? DEFAULT_SELFTEST_MANIFEST_FILE
  if (!isSafeSelfTestManifestFile(manifestFile)) {
    console.warn(
      `[Updater] Ignoring selftest update source: manifestFile must be a non-production cmbdevclaw-latest*.json file`
    )
    return fallback
  }

  let baseUrl = fallback.baseUrl
  const configuredBaseUrl = readStringField(raw, "baseUrl")
  if (configuredBaseUrl) {
    const normalizedBaseUrl = normalizeBaseUrl(configuredBaseUrl)
    if (!isValidHttpBaseUrl(normalizedBaseUrl)) {
      console.warn("[Updater] Ignoring selftest update source: baseUrl must be http(s)")
      return fallback
    }
    baseUrl = normalizedBaseUrl
  }

  return {
    channel: "selftest",
    baseUrl,
    manifestFile,
    configPath: options.configPath,
    expiresAt: expiresAt ?? undefined
  }
}

export function resolveUpdateSource(defaultBaseUrl: string): UpdateSourceInfo {
  const configPath = getUpdateChannelConfigPath()
  const fallback = makeProductionSource(defaultBaseUrl)
  if (!existsSync(configPath)) return fallback

  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "")
    return resolveUpdateSourceFromConfig(JSON.parse(raw), defaultBaseUrl, { configPath })
  } catch (err) {
    console.warn(
      "[Updater] Failed to read update-channel.json, using production update source:",
      err
    )
    return fallback
  }
}

export function isSelfTestUpdateSource(source: UpdateSourceInfo | null | undefined): boolean {
  return source?.channel === "selftest"
}
