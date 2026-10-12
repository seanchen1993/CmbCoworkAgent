import { z } from "zod"
import { createHash } from "node:crypto"
export const windowsProvisioning = z
  .object({
    cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
    codexHome: z
      .object({
        path: z.string().min(1).max(4096),
        dev: z.string().regex(/^\d+$/),
        ino: z.string().regex(/^\d+$/)
      })
      .strict()
  })
  .strict()
export const windowsProvisioningAuthorization = z
  .object({
    format: z.literal(1),
    nonce: z.string().uuid(),
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const windowsProvisioningTerminal = windowsProvisioningAuthorization
  .extend({ cliSha256: z.string().regex(/^[a-f0-9]{64}$/), completed: z.literal(true) })
  .strict()
/** Same immutable native origin projection as the closure reader. */
export function windowsProvisioningBinding(record: { origin: object; resource: unknown }): string {
  const origin = Object.fromEntries(
    Object.entries(record.origin).filter(
      ([key]) => !["phase", "runAuthorized", "helperPid", "workerPid"].includes(key)
    )
  )
  return createHash("sha256")
    .update(JSON.stringify({ origin, resource: record.resource }))
    .digest("hex")
}
