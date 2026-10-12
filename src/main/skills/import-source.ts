import { z } from "zod"
import { SKILL_IMPORT_MAX_BYTES, type SkillImportResult } from "../../shared/skill-import"
import { inspectSkillImport } from "./import-preview"

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().trim().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal("file"),
      fileName: z.string().min(1).max(255),
      buffer: z
        .instanceof(ArrayBuffer)
        .refine((value) => value.byteLength <= SKILL_IMPORT_MAX_BYTES)
    })
    .strict()
])

function sourceUrl(value: string): URL {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("请输入不含账号密码的 HTTP 或 HTTPS 文件链接")
  url.hash = ""
  return url
}

/** User-selected sources only. No browser cookies, custom headers or ambient
 * credentials. Internal HTTP URLs remain usable for enterprise skill servers.
 * Each redirect is revalidated; timeout covers both headers and body. */
export async function readSkillImportSource(
  raw: unknown,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<SkillImportResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const input = inputSchema.parse(raw)
    combined.throwIfAborted()
    let buffer: Buffer
    let fileName: string
    if (input.kind === "file") {
      buffer = Buffer.from(input.buffer)
      fileName = input.fileName
    } else {
      let url = sourceUrl(input.url)
      for (let redirects = 0; ; redirects++) {
        const response = await (options.fetch ?? fetch)(url, {
          signal: combined,
          redirect: "manual",
          credentials: "omit",
          headers: {
            Accept: "text/markdown, text/plain, application/zip, application/octet-stream"
          }
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get("location")
          if (!location || redirects >= 3) throw new Error("技能链接重定向过多或缺少目标")
          const next = sourceUrl(new URL(location, url).href)
          if (url.protocol === "https:" && next.protocol !== "https:")
            throw new Error("技能链接不能从 HTTPS 降级到 HTTP")
          url = next
          continue
        }
        try {
          if (!response.ok) throw new Error(`下载技能失败（HTTP ${response.status}）`)
          if (response.headers.get("content-type")?.toLowerCase().includes("text/html"))
            throw new Error("链接返回网页，请使用 SKILL.md 或 ZIP 的原始文件链接")
          if (Number(response.headers.get("content-length")) > SKILL_IMPORT_MAX_BYTES)
            throw new Error("技能文件超过 5 MiB")
          if (!response.body) throw new Error("技能文件为空")
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let bytes = 0
          try {
            for (;;) {
              const { value, done } = await reader.read()
              combined.throwIfAborted()
              if (done) break
              bytes += value.byteLength
              if (bytes > SKILL_IMPORT_MAX_BYTES) throw new Error("技能文件超过 5 MiB")
              chunks.push(value)
            }
          } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          buffer = Buffer.concat(chunks, bytes)
          fileName = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))
            ? "skill.zip"
            : "SKILL.md"
          break
        } finally {
          if (!response.body?.locked) await response.body?.cancel().catch(() => {})
        }
      }
    }
    combined.throwIfAborted()
    const preview = inspectSkillImport(buffer, fileName)
    return {
      success: true,
      preview,
      file: {
        fileName,
        buffer: Uint8Array.from(buffer).buffer
      }
    }
  } catch (error) {
    return {
      success: false,
      error: signal.aborted
        ? "已取消读取技能"
        : timeout.aborted
          ? "读取技能超时，请重试"
          : error instanceof Error
            ? error.message
            : "无法读取技能"
    }
  }
}
