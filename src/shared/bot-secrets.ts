import { z } from "zod"

const secretCard = z.object({
  secretRequest: z.object({
    version: z.literal(1),
    label: z.string().min(1).max(120),
    description: z.string().max(400),
    botId: z.string().min(1).max(200),
    token: z.string().uuid(),
    origin: z.string().url().max(8192),
    path: z.string().max(8192),
    field: z.string().max(120)
  })
})
export type BotSecretCard = z.infer<typeof secretCard>["secretRequest"]
export function readBotSecretCard(prompt: string): BotSecretCard | null {
  try {
    return secretCard.safeParse(JSON.parse(prompt)).data?.secretRequest ?? null
  } catch {
    return null
  }
}
export interface BotSecretInput {
  id: string
  revision: number
  value: string
}

export interface BotSecretMetadata {
  id: string
  botId: string
  name: string
  description: string
  origin: string
  revision: number
  updatedAt: number
}
export interface BotSecretSaveInput {
  botId: string
  id?: string
  revision?: number
  name: string
  description: string
  origin: string
  value: string
}
export interface BotSecretCatalog {
  persistent: boolean
  protection?: "windows-dpapi" | "macos-keychain" | "external" | "memory"
  items: BotSecretMetadata[]
}

export function botSecretProtectionDescription(catalog: BotSecretCatalog): string {
  if (!catalog.persistent) return "当前环境仅在 Bot 服务运行期间保留凭据；服务重启后需要重新添加。"
  const storage =
    catalog.protection === "macos-keychain"
      ? "使用 macOS 钥匙串保护并加密保存。首次使用可能需要系统授权。"
      : catalog.protection === "windows-dpapi"
        ? "使用当前 Windows 账户加密保存。"
        : "使用服务端配置的加密方式保存。"
  return `${storage}其他 Bot 无法使用，复制 Bot 也不会复制凭据。`
}

const secretUseCard = z.object({
  secretUse: z.object({
    version: z.literal(1),
    credential: z.object({
      id: z.string().min(1).max(200),
      name: z.string().min(1).max(120),
      revision: z.number().int().positive()
    }),
    destination: z.object({
      botId: z.string().min(1).max(200),
      token: z.string().uuid(),
      origin: z.string().url().max(8192),
      path: z.string().max(8192),
      field: z.string().max(120)
    })
  })
})
export type BotSecretUseCard = z.infer<typeof secretUseCard>["secretUse"]
export function readBotSecretUseCard(prompt: string): BotSecretUseCard | null {
  try {
    return secretUseCard.safeParse(JSON.parse(prompt)).data?.secretUse ?? null
  } catch {
    return null
  }
}
