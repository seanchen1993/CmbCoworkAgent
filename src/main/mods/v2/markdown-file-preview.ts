import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionMarkdownUrlTransform } from "../../../shared/mods/v2/markdown"
import type { FunctionMarkdownProtectedPreview } from "../../../shared/mods/v2/markdown-links"
import { FUNCTION_READ_LIMIT, ProjectFunctionFiles, type FunctionFileScope } from "./file-access"
import type { ModJson } from "../../../shared/mods/types"

/** Reject raw nonempty authority before WHATWG normalizes localhost to an empty hostname. */
export function functionMarkdownFilePath(href: string): string {
  if (!/^file:\/\/\/(?!\/)/i.test(href) || functionMarkdownUrlTransform(href) !== href)
    throw new ModFunctionError("MODS_UI_MARKDOWN_FILE_INVALID")
  try {
    return fileURLToPath(href)
  } catch {
    throw new ModFunctionError("MODS_UI_MARKDOWN_FILE_INVALID")
  }
}

interface PreviewRecord {
  assertCurrent(): void
  preview: FunctionMarkdownProtectedPreview
}

/** Only protected text is retained. No renderer ever receives a path for another read. */
export class FunctionMarkdownFilePreviews {
  private readonly records = new Map<string, PreviewRecord>()
  private closed = false
  private pending = 0

  constructor(private readonly invalidated: (receipt: string) => void = () => {}) {}

  async read(
    href: string,
    scope: FunctionFileScope,
    assertCurrent: () => void,
    publish: (value: ModJson, signal: AbortSignal) => Promise<ModJson>,
    signal: AbortSignal
  ): Promise<FunctionMarkdownProtectedPreview> {
    const guard = () => {
      if (this.closed) throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
      signal.throwIfAborted()
      scope.assertLive()
      assertCurrent()
    }
    guard()
    // A native read is never allowed to fall into ProjectFunctionFiles' optional-query fallback.
    if (typeof scope.queryTool !== "function") throw new ModFunctionError("MODS_FS_ACCESS_DENIED")
    for (const receipt of this.records.keys()) this.current(receipt)
    if (this.records.size + this.pending >= 8)
      throw new ModFunctionError("MODS_UI_MARKDOWN_PREVIEW_LIMIT")
    this.pending++
    try {
      const path = functionMarkdownFilePath(href)
      const files = new ProjectFunctionFiles(scope.workspace, guard, publish, scope.queryTool)
      const text = await files.run("fs.read", path, signal, { readText: true })
      guard()
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > FUNCTION_READ_LIMIT ||
        // eslint-disable-next-line no-control-regex -- Protected previews remain plain text.
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)
      )
        throw new ModFunctionError("MODS_UI_MARKDOWN_PREVIEW_INVALID")
      const preview = Object.freeze({ receipt: randomUUID(), title: "模组文件预览", text })
      this.records.set(preview.receipt, { preview, assertCurrent: guard })
      return preview
    } finally {
      this.pending--
    }
  }

  current(receipt: string): boolean {
    const record = this.records.get(receipt)
    if (!record || this.closed) return false
    try {
      record.assertCurrent()
      return true
    } catch {
      this.records.delete(receipt)
      this.notify(receipt)
      return false
    }
  }

  snapshot(receipt: string): FunctionMarkdownProtectedPreview | null {
    return this.current(receipt) ? this.records.get(receipt)!.preview : null
  }

  release(receipt: string): void {
    this.records.delete(receipt)
  }

  private notify(receipt: string): void {
    try {
      this.invalidated(receipt)
    } catch {
      /* A closing renderer cannot interrupt native retirement. */
    }
  }

  close(): void {
    this.closed = true
    for (const receipt of this.records.keys()) this.notify(receipt)
    this.records.clear()
  }
}
