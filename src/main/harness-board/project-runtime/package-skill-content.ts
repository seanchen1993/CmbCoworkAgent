import { join } from "node:path"
import {
  decodeMarketContent,
  getMarketContentStoredLimit,
  MARKET_CONTENT_PREFIX
} from "../../services/market-content"
import { hostStateError } from "./host-state-protocol"
import { readRuntimeScopedFile } from "./safe-files"

const maxSkillBytes = 256 * 1024
const maxStoredSkillBytes = Math.ceil(maxSkillBytes / 3) * 4 +
  Buffer.byteLength(MARKET_CONTENT_PREFIX)

/** Interpret only after bounded identity-checked reads; snapshots keep the stored bytes. */
export function decodeHostPackageSkill(bytes: Buffer): Buffer {
  if (bytes.length > maxStoredSkillBytes) hostStateError("FILE_LIMIT")
  const content = decodeMarketContent(bytes)
  if (content.length > maxSkillBytes) hostStateError("FILE_LIMIT")
  return content
}

export function readHostPackageSkill(root: string, path: string): Buffer {
  const file = readRuntimeScopedFile(
    root,
    path,
    getMarketContentStoredLimit(join(root, path), maxSkillBytes)
  )
  if (!file.bytes) hostStateError("SKILL_MISSING")
  return decodeHostPackageSkill(file.bytes)
}
