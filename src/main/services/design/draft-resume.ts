import fs from "node:fs"
import path from "node:path"
import { inspectDesignDocument, type DesignDraftPreview } from "../../../shared/design-progressive"
import type { Message } from "../../../shared/managed-design-session"
import { readTweakDeclaration, reconcileTweaks } from "../../../shared/design-tweaks"

/** Older retries discarded the preview pointer. Recover only proven writes for this user turn. */
export function recoverDesignDraftCheckpoint(
  workspacePath: string, artifactPath: string, messages: Message[]
): DesignDraftPreview | null {
  try {
    const directory = path.dirname(path.resolve(artifactPath))
    const realDirectory = fs.realpathSync(directory)
    const relative = path.relative(fs.realpathSync(workspacePath), realDirectory)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null
    let start = messages.length - 1
    while (start >= 0 && messages[start].role !== "user") start--
    if (start < 0) return null
    const seen = new Set<string>()
    for (const message of messages.slice(start + 1).reverse()) {
      const events = message.executionEvents ?? []
      for (const call of [...events].reverse()) {
        if (call.kind !== "tool_call" || !["write_file", "edit_file"].includes(call.name ?? "")) continue
        const callId = call.toolCallId || call.id
        const result = callId ? events.findLast((event) => event.kind === "tool_result" && event.toolCallId === callId) : undefined
        if (call.isError || result?.isError || (result?.status ?? call.status) !== "success") continue
        const raw = call.args?.file_path
        if (typeof raw !== "string" || !raw.trim()) continue
        const filePath = path.resolve(workspacePath, raw)
        if (path.dirname(filePath) !== directory || !/^\.draft-[\w.-]+\.html$/.test(path.basename(filePath)) || seen.has(filePath)) continue
        seen.add(filePath)
        if (seen.size > 8) return null
        try {
          if (path.dirname(fs.realpathSync(filePath)) !== realDirectory) continue
          const before = fs.statSync(filePath)
          if (!before.isFile() || before.size > 8 * 1024 * 1024) continue
          const html = fs.readFileSync(filePath, "utf8"), after = fs.statSync(filePath)
          if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue
          const inspection = inspectDesignDocument(html)
          if (!inspection.valid) continue
          return {
            runId: "recovered-checkpoint", revision: 0, html, draftPath: filePath,
            phase: "sections", status: "incomplete", sections: inspection.sections,
            completedSections: inspection.completedSections, totalSections: inspection.totalSections,
            tweaks: reconcileTweaks(readTweakDeclaration(html)), createdAt: before.birthtimeMs,
            updatedAt: before.mtimeMs
          }
        } catch { /* A missing or malformed candidate is not a usable checkpoint. */ }
      }
    }
  } catch { /* The workspace may have moved or been removed. */ }
  return null
}

/** Seed a fresh run-owned file from the durable checkpoint before invoking the model. */
export function prepareDesignDraftResume(workspacePath: string, draftPath: string, html: string) {
  const inspection = inspectDesignDocument(html)
  if (!html.trim() || !inspection.valid)
    throw new Error("恢复草稿为空或结构不完整，已停止接续，未重新创建页面")
  const relative = path.relative(path.resolve(workspacePath), path.resolve(draftPath))
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("恢复草稿路径超出当前工作目录")
  fs.mkdirSync(path.dirname(draftPath), { recursive: true })
  // Never reuse the previous run's mutable file or overwrite an existing candidate.
  fs.writeFileSync(draftPath, html, { flag: "wx" })
  return inspection
}

/** A continuation may complete more sections, but cannot reset completed ones to placeholders. */
export function validateDesignDraftResumeEdit(before: string, after: string): string | undefined {
  const previous = inspectDesignDocument(before)
  const next = inspectDesignDocument(after, previous.sections)
  if (!next.valid) return `接续修改会破坏已保存草稿：${next.issues.slice(0, 3).join("；")}。请仅修改相关内容，保留页面和区块闭合。`
  const regressed = previous.completedSections.filter((id) => !next.completedSections.includes(id))
  if (regressed.length)
    return `不能将已完成区块 ${regressed.join("、")} 重新变成占位内容。请从当前草稿继续，不要重建框架。`
  return undefined
}

export function buildDesignDraftResumeArtifactInstruction(filePath: string): string {
  return `\n\nDESIGN CONTINUATION ARTIFACT\n${filePath}\n` +
    "The host has already saved the exact latest unfinished page at this path. This is the existing working file, not a reference template. " +
    "Use bounded read_file calls on this file to locate the remaining sections, then edit_file in place. " +
    "Do not create another output file, call write_file, write a new scaffold, or recreate completed sections. " +
    "Preserve existing content, styles, scripts, local assets, section IDs and user-adjusted values. " +
    'Complete pending sections and interactions; remove data-design-pending only as each section is finished. When everything is ready, remove data-design-build or set it to "complete". ' +
    "The host previews each successful edit and validates the finished page. Finish with a brief Chinese summary."
}

export const DESIGN_DRAFT_RESUME_SYSTEM_PROMPT = `You are continuing an existing, partially completed HTML design artifact after an interruption or error.
The host has materialized the latest durable page in the supplied working file. The current page is authoritative, including completed sections, styles, scripts, assets and user changes. Resume its unfinished work in place; do not design from scratch, recreate a scaffold, reapply the initial template or copy an older page over it.
Use read_file({file_path,offset,limit}) only for the relevant current file ranges, then edit_file({file_path,old_string,new_string,replace_all}) for meaningful batches of changes. Retain known anchors between successful edits. Do not use write_file, shell, code execution or subagents to replace the page. Keep HTML and section wrappers closed after every edit. Preserve every existing data-design-section ID and never mark a completed section pending again.
Use the original requirements and confirmed answers to complete remaining sections and business interactions. Preserve existing Tweaks declarations, bindings and user-adjusted values; visual bindings must still target real DOM nodes. Preserve the selected template's framework and local dependencies already in the page.
When all work is complete, remove remaining pending/build markers or set data-design-build="complete". End the turn; the host performs browser validation. If the page is already complete, leave it intact for validation. Keep public progress and the final summary brief and in Chinese.`
