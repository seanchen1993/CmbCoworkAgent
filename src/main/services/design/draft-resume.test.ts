import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "../../agent/local-sandbox"
import { DesignDraftPublisher } from "./draft-preview"
import { buildDesignDraftResumeArtifactInstruction, prepareDesignDraftResume, validateDesignDraftResumeEdit, recoverDesignDraftCheckpoint } from "./draft-resume"
import type { Message } from "../../../shared/managed-design-session"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const partial = '<!doctype html><html><head><style>.hero{color:red}</style></head><body data-design-build="building"><section data-design-section="hero"><h1>已完成的标题</h1></section><section data-design-section="details" data-design-pending>已完成一半的统计内容</section><script>window.preserved=true</script></body></html>'
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-resume-"))
  roots.push(root)
  return root
}

describe("Design resume execution files", () => {
  it("recovers a legacy discarded preview only from successful writes in this user turn and artifact directory", () => {
    const root = directory(), artifacts = path.join(root, ".cmb-design", "ds_design-main")
    fs.mkdirSync(artifacts, { recursive: true })
    const target = path.join(artifacts, ".draft-123.html"), other = path.join(root, ".draft-other.html")
    fs.writeFileSync(target, partial)
    fs.writeFileSync(other, partial.replace("已完成的标题", "无关页面"))
    const messages: Message[] = [{ role: "user", content: "创建当前页面" }, { role: "assistant", content: "生成失败", executionEvents: [
      { kind: "tool_call", id: "saved", name: "edit_file", args: { file_path: target }, status: "running", timestamp: 1 },
      { kind: "tool_result", toolCallId: "saved", status: "success", timestamp: 2 },
      { kind: "tool_call", name: "write_file", args: { file_path: other }, status: "success", timestamp: 3 }
    ] }, { role: "assistant", content: "旧版本重试未带草稿", executionEvents: [] }]
    expect(recoverDesignDraftCheckpoint(root, path.join(artifacts, "index.html"), messages)).toMatchObject({ html: partial, draftPath: target })
    expect(recoverDesignDraftCheckpoint(root, path.join(artifacts, "index.html"), [...messages, { role: "user", content: "一个新需求" }])).toBeNull()
    const failedOnly: Message[] = [{ role: "user", content: "新任务" }, { role: "assistant", content: "", executionEvents: [
      { kind: "tool_call", name: "write_file", args: { file_path: target }, status: "error", timestamp: 4 }
    ] }]
    expect(recoverDesignDraftCheckpoint(root, path.join(artifacts, "index.html"), failedOnly)).toBeNull()
    if (process.platform !== "win32") {
      const link = path.join(artifacts, ".draft-link.html")
      fs.symlinkSync(other, link)
      failedOnly[1].executionEvents![0] = { kind: "tool_call", name: "write_file", args: { file_path: link }, status: "success", timestamp: 5 }
      expect(recoverDesignDraftCheckpoint(root, path.join(artifacts, "index.html"), failedOnly)).toBeNull()
    }
  })
  it("materializes the exact durable source before model execution and isolates late writes from the failed run", () => {
    const root = directory(), old = path.join(root, "old.html"), next = path.join(root, "continued.html")
    fs.writeFileSync(old, partial)
    expect(prepareDesignDraftResume(root, next, partial)).toMatchObject({ completedSections: ["hero"], finalizable: false })
    expect(fs.readFileSync(next, "utf8")).toBe(partial)
    fs.writeFileSync(old, "late write from the failed run")
    expect(fs.readFileSync(next, "utf8")).toBe(partial)
    expect(() => prepareDesignDraftResume(root, next, "<!doctype html><html><body>新框架</body></html>")).toThrow()
    expect(fs.readFileSync(next, "utf8")).toBe(partial)
    const instruction = buildDesignDraftResumeArtifactInstruction(next)
    expect(instruction).toContain("already saved the exact latest unfinished page")
    expect(instruction).not.toContain("Create it with write_file")
  })

  it("edits the seeded page with the real sandbox and rejects a restart before it overwrites the file", async () => {
    const root = directory(), target = path.join(root, "continued.html")
    prepareDesignDraftResume(root, target, partial)
    const mutated = vi.fn()
    const sandbox = new LocalSandbox({ rootDir: root, runId: "resume",
      onFileMutation: mutated,
      validateFileWrite: (_file, content) => validateDesignDraftResumeEdit(fs.readFileSync(target, "utf8"), content) })
    await sandbox.read(target, 0, 10)
    const reset = partial.replace('data-design-section="hero"', 'data-design-section="hero" data-design-pending')
    expect((await sandbox.edit(target, partial, reset)).error).toContain("不能将已完成区块 hero")
    expect(fs.readFileSync(target, "utf8")).toBe(partial)
    expect(mutated).not.toHaveBeenCalled()
    expect((await sandbox.edit(target, partial, partial.replace(/<section data-design-section="details".*?<\/section>/, ""))).error).toContain("缺少预期区块 details")
    const finished = partial.replace(" data-design-pending", "").replace("已完成一半的统计内容", "统计内容已补完").replace('data-design-build="building"', 'data-design-build="complete"')
    expect((await sandbox.edit(target, partial, finished)).error).toBeUndefined()
    expect(fs.readFileSync(target, "utf8")).toBe(finished)
    expect(mutated).toHaveBeenCalledOnce()
    expect((await sandbox.edit(target, 'data-design-section="details"', 'data-design-section="details" data-design-pending')).error).toContain("不能将已完成区块 details")
    expect(fs.readFileSync(target, "utf8")).toBe(finished)
    const retry = path.join(root, "retry.html")
    expect(prepareDesignDraftResume(root, retry, fs.readFileSync(target, "utf8")).finalizable).toBe(true)
    expect(fs.readFileSync(retry, "utf8")).toContain("已完成的标题")
    expect(fs.readFileSync(retry, "utf8")).toContain("window.preserved=true")
  })

  it("flushes the latest successful mutation before reporting an error and seeds the retry from that revision", async () => {
    const root = directory(), target = path.join(root, "draft.html")
    fs.writeFileSync(target, partial)
    const controller = new AbortController(), publish = vi.fn()
    const publisher = new DesignDraftPublisher({ runId: "failed", workspacePath: root, draftPath: target,
      signal: controller.signal, throttleMs: 60_000, publish })
    publisher.notify(target)
    await publisher.flush()
    const latest = partial.replace("已完成一半的统计内容", "出错前刚保存的新统计内容")
    fs.writeFileSync(target, latest)
    publisher.notify(target)
    expect(publisher.latest?.html).toBe(partial)
    // The terminal error path must flush before abort disposes the publisher.
    await publisher.flush()
    controller.abort()
    const next = path.join(root, "next.html")
    prepareDesignDraftResume(root, next, publisher.latest!.html)
    expect(fs.readFileSync(next, "utf8")).toBe(latest)
  })

  it("refuses missing/broken checkpoints and never silently falls back to a blank framework", () => {
    const root = directory(), target = path.join(root, "continued.html")
    for (const html of ["", "<section>残缺"]) expect(() => prepareDesignDraftResume(root, target, html)).toThrow("未重新创建页面")
    expect(fs.existsSync(target)).toBe(false)
    expect(() => prepareDesignDraftResume(root, path.join(root, "..", "escaped.html"), partial)).toThrow("超出当前工作目录")
  })
})
