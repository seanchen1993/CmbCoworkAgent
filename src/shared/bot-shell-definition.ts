import { z } from "zod"

export const botShellDefinition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), path: z.string().max(4096) }).strict(),
  z
    .object({
      kind: z.enum(["executable", "package_script"]),
      path: z.string().min(1).max(4096),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      definition: z.string().max(8000)
    })
    .strict()
])
export type BotShellDefinition = z.infer<typeof botShellDefinition>
