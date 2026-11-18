import fs from "node:fs"
import path from "node:path"
import { parse } from "parse5"
import { applyHtmlSourceEdits } from "../../../shared/design-html-mutations"
import { designAttr } from "../../../shared/design-node-ids"
import { elements } from "../../../shared/design-tweaks"
import { CAPTURE_FRAME_ATTRIBUTE, capturedFrameReference, isCapturedFrameScreenshot } from "../../../shared/design-captured-frame"
import { sourceHash } from "./document-index"
import { writeDesignFilesAtomically } from "./artifact-storage"

const MAX_CAPTURE_HTML_BYTES = 15 * 1024 * 1024

export function editableCapturePath(
  workspace: string | null | undefined,
  id: string,
  artifactPath: string | null | undefined
): string | undefined {
  if (!workspace || !artifactPath || !/^ds_[\w-]+$/.test(id)) return undefined
  const name = `${id}_design-main`
  if (path.resolve(artifactPath) !== path.resolve(workspace, ".cmb-design", name, "index.html")) return undefined
  const expected = path.join(fs.realpathSync(workspace), ".cmb-design", name)
  return fs.realpathSync(path.dirname(artifactPath)) === expected ? artifactPath : undefined
}

export interface CapturedFrameSource {
  id: string
  file: string
  html: string
  editable: boolean
  children: CapturedFrameSource[]
  srcRange: { start: number; end: number }
}

/** Only follow the exact local references produced by capture or this module. */
export function readCapturedFrames(html: string, artifactPath?: string | null) {
  const byId = new Map<string, CapturedFrameSource>()
  const sources = new Map<string, string>()
  if (!artifactPath || !html.includes(CAPTURE_FRAME_ATTRIBUTE))
    return { byId, sources, roots: [] }
  const directory = path.dirname(artifactPath)
  const frameDir = path.join(directory, "frames")
  let safeDirectory: string | undefined
  let remaining = MAX_CAPTURE_HTML_BYTES
  const visit = (source: string, depth: number): CapturedFrameSource[] => {
    if (depth >= 4 || !source.includes(CAPTURE_FRAME_ATTRIBUTE)) return []
    const out: CapturedFrameSource[] = []
    for (const el of elements(parse(source, { sourceCodeLocationInfo: true }))) {
      if (el.tagName !== "iframe") continue
      const id = designAttr(el, CAPTURE_FRAME_ATTRIBUTE) ?? ""
      const src = designAttr(el, "src") ?? ""
      const loc = el.sourceCodeLocation?.attrs?.src
      if (!loc || !capturedFrameReference(id, src, depth > 0)) continue
      if (byId.has(id) || byId.size >= 32) throw new Error("抓取的嵌入页面标识重复或超过数量限制")
      safeDirectory ??= path.join(fs.realpathSync(directory), "frames")
      const file = path.join(frameDir, path.basename(src))
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || fs.realpathSync(file) !== path.join(safeDirectory, path.basename(file)))
        throw new Error("嵌入页面文件路径无效")
      remaining -= stat.size
      if (remaining < 0) throw new Error("嵌入页面超过大小限制")
      const html = fs.readFileSync(file, "utf8")
      const revision = /-([a-f0-9]{64})\.html$/.exec(file)?.[1]
      if (revision && sourceHash(html) !== `sha256:${revision}`)
        throw new Error("嵌入页面文件已变化")
      const frame: CapturedFrameSource = {
        id, file, html,
        editable: !isCapturedFrameScreenshot(html),
        srcRange: { start: loc.startOffset, end: loc.endOffset },
        children: []
      }
      byId.set(id, frame)
      sources.set(file, html)
      frame.children = visit(html, depth + 1)
      out.push(frame)
    }
    return out
  }
  return { byId, sources, roots: visit(html, 0) }
}

/** Publish child revisions before changing their parent references. The existing HTML
 * journal can then undo or redo an entire frame tree with one root revision. */
export function updateCapturedFrames(
  html: string,
  roots: CapturedFrameSource[],
  changes: Map<string, string>
): string {
  let remaining = MAX_CAPTURE_HTML_BYTES
  const writes: Array<{ filePath: string; content: string }> = []
  const applied = new Set<string>()
  function replace(source: string, frames: CapturedFrameSource[], prefix: string): string {
    const output = applyHtmlSourceEdits(source, frames.flatMap((frame) => {
      const base = changes.get(frame.id) ?? frame.html
      if (changes.has(frame.id)) applied.add(frame.id)
      const children = base === frame.html ? frame.children : remapChildren(base, frame.children)
      const updated = replace(base, children, "../")
      if (updated === frame.html) return []
      const name = `${frame.id}-${sourceHash(updated).slice(7)}.html`
      const directory = path.dirname(frame.file)
      const file = path.join(directory, name)
      const existing = fs.lstatSync(file, { throwIfNoEntry: false })
      if (!existing) writes.push({ filePath: file, content: updated })
      else if (!existing.isFile() || fs.readFileSync(file, "utf8") !== updated)
        throw new Error("嵌入页面版本文件已变化")
      return [{ ...frame.srcRange, value: `src="${prefix}frames/${name}"` }]
    }))
    remaining -= Buffer.byteLength(output)
    if (remaining < 0) throw new Error("嵌入页面超过大小限制")
    return output
  }
  const output = replace(html, remapChildren(html, roots), "")
  if (applied.size !== changes.size) throw new Error("被标记的嵌入页面已移除，请重新标记")
  if (writes.length) writeDesignFilesAtomically(writes)
  return output
}

function remapChildren(html: string, frames: CapturedFrameSource[]): CapturedFrameSource[] {
  if (!frames.length) return []
  const byId = new Map(frames.map((frame) => [frame.id, frame]))
  return elements(parse(html, { sourceCodeLocationInfo: true })).flatMap(el => {
    const frame = el.tagName === "iframe" && byId.get(designAttr(el, CAPTURE_FRAME_ATTRIBUTE) ?? "")
    const loc = el.sourceCodeLocation?.attrs?.src
    if (!frame || !loc) return []
    return [{ ...frame, srcRange: { start: loc.startOffset, end: loc.endOffset } }]
  })
}
