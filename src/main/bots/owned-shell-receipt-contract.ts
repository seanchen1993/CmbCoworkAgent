import { z } from "zod"
export const OWNED_SHELL_MAX_UNCONFIRMED = 64
export const OWNED_SHELL_RECEIPT_BYTES = 32 * 1024
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identity = { dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/) }
export const ownedShellReceiptSchema = z
  .object({
    format: z.literal(1),
    nonce: z.string().uuid(),
    hostId: z.string().min(1).max(512),
    dataEpoch: z.string().min(1).max(512),
    policySha256: hash,
    runId: z.string().min(1).max(512),
    helperSha256: hash,
    workerSha256: hash,
    nativeProviderSha256: hash.optional(),
    directory: z.object(identity).strict(),
    scratch: z
      .object({ path: z.string().min(1).max(4096), ...identity })
      .strict()
      .optional(),
    endpoint: z
      .object({ path: z.string().min(1).max(4096), ...identity })
      .strict()
      .optional(),
    phase: z.enum([
      "allocated",
      "worker-ready",
      "run-authorized",
      "resource-closed",
      "closure-unproven"
    ]),
    runAuthorized: z.boolean(),
    // Version-1 records without this field retain diagnostic value but cannot
    // prove that an authorized command's entire process resource was closed.
    containment: z
      .enum([
        "controlled-inherited-group",
        "verified-windows-job",
        "verified-linux-cgroup-v2",
        "verified-windows-atomic-job-v2"
      ])
      .optional(),
    helperPid: z.number().int().positive().max(0x7fffffff).optional(),
    workerPid: z.number().int().positive().max(0x7fffffff).optional()
  })
  .strict()
  .refine(
    (value) => (value.helperPid === undefined) === (value.workerPid === undefined),
    "Resource PIDs must be a pair"
  )
  .refine(
    (value) => value.phase !== "run-authorized" || value.runAuthorized,
    "Run authorization record is incomplete"
  )
  .refine(
    (value) =>
      !value.runAuthorized || (value.helperPid !== undefined && value.workerPid !== undefined),
    "Authorized resource PIDs are missing"
  )
export type OwnedShellReceipt = z.infer<typeof ownedShellReceiptSchema>
export type OwnedShellOrigin = Pick<OwnedShellReceipt, "hostId" | "dataEpoch" | "policySha256">

/** A process group is not a kernel containment boundary: setsid/setpgid and
 * POSIX_SPAWN_SETPGROUP can leave live descendants outside it. Only an actual
 * kernel closure (or a never-authorized resource) is cleanup authority.
 * A Windows metadata flag from the legacy controller does not attest atomic
 * Job enrollment. Only the fixed v2 producer and live admission protocol can
 * authorize the distinct atomic Job capability. */
export function hasOwnedShellPhysicalClosure(receipt: OwnedShellReceipt): boolean {
  return (
    receipt.phase === "resource-closed" &&
    (!receipt.runAuthorized || isOwnedShellStrongContainment(receipt.containment))
  )
}

export function isOwnedShellStrongContainment(kind: OwnedShellReceipt["containment"]): boolean {
  return kind === "verified-linux-cgroup-v2" || kind === "verified-windows-atomic-job-v2"
}
