import { z } from "zod"

export const botFileOrigin = z.enum([
  "upload",
  "generated",
  "browser",
  "project",
  "command",
  "skill",
  "connector",
  "peer"
])
export type BotFileOrigin = z.infer<typeof botFileOrigin>

export const botFileDeleteInput = z
  .object({
    nonce: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    id: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedDataEpoch: z.string().min(1).max(160).optional()
  })
  .strict()
export type BotFileDeleteInput = z.infer<typeof botFileDeleteInput>
export interface BotFileDeleted {
  id: string
  deletedAt: number
}

export const BOT_FILE_ORIGIN_LABELS: Record<BotFileOrigin, string> = {
  upload: "用户上传",
  generated: "Bot 生成",
  browser: "浏览器下载",
  project: "项目文件",
  command: "命令输出",
  skill: "技能文件",
  connector: "连接器结果",
  peer: "Bot 协作"
}
