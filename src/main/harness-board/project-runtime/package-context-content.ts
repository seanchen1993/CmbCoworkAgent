import { join } from "node:path"
import { decodeMarketContent, getMarketContentStoredLimit } from "../../services/market-content"
import { readRuntimeScopedFile } from "./safe-files"
import { hostStateError } from "./host-state-protocol"

/** Preserve the raw observation/digest; decode only native-declared package content. */
export function readScopedContextContent(
  root: string, path: string, maxBytes: number, packageSource: boolean
) {
  const file = readRuntimeScopedFile(root, path, packageSource
    ? getMarketContentStoredLimit(join(root, path), maxBytes) : maxBytes)
  const content = file.bytes && (packageSource ? decodeMarketContent(file.bytes) : file.bytes)
  if (content && content.length > maxBytes) hostStateError("FILE_LIMIT")
  return { ...file, content }
}
