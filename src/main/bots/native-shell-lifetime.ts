import { z } from "zod"
import { linuxBotCgroupScope } from "./linux-bot-cgroup"
import { windowsBotJobScope } from "./windows-native-contract"
import { ownedShellReceiptSchema } from "./owned-shell-receipt-contract"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const nativeShellLifetime = z.discriminatedUnion("kind", [
  z
    .object({
      format: z.literal(1),
      kind: z.literal("verified-windows-job"),
      nonce: z.string().uuid(),
      jobName: z.string().regex(/^Local\\CMBDevClaw-Bot-[a-f0-9-]{36}$/i),
      providerSha256: digest
    })
    .strict(),
  windowsBotJobScope,
  linuxBotCgroupScope.extend({ providerSha256: digest }).strict()
])
export type NativeShellLifetime = z.infer<typeof nativeShellLifetime>
/** Persisted in the rollback-excluded operation slot before native launch.
 * Origin comes from the existing receipt. Numeric PIDs are only diagnostics,
 * never a kernel resource identity or permission to kill an old process. */
export const nativeShellLifetimeRecord = z
  .object({
    format: z.literal(1),
    origin: ownedShellReceiptSchema,
    resource: nativeShellLifetime
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin.containment !== value.resource.kind)
      context.addIssue({
        code: "custom",
        message: "Native scope differs from declared operation containment"
      })
    if (
      value.resource.kind === "verified-linux-cgroup-v2" &&
      value.resource.leaf.path !== `${value.resource.root.path}/cmb-bot-${value.resource.nonce}`
    )
      context.addIssue({
        code: "custom",
        message: "Linux leaf does not belong to the exact delegated root"
      })
    if (value.origin.nonce !== value.resource.nonce)
      context.addIssue({ code: "custom", message: "Native resource nonce differs from operation" })
    if (
      ["verified-windows-job", "verified-windows-atomic-job-v2"].includes(value.resource.kind) &&
      "jobName" in value.resource &&
      value.resource.jobName !== `Local\\CMBDevClaw-Bot-${value.origin.nonce}`
    )
      context.addIssue({ code: "custom", message: "Native Job name differs from operation" })
  })
export type NativeShellLifetimeRecord = z.infer<typeof nativeShellLifetimeRecord>
export const nativeShellClosure = z
  .object({
    format: z.literal(2),
    scope: z.enum([
      "verified-windows-job",
      "verified-windows-atomic-job-v2",
      "verified-linux-cgroup-v2"
    ]),
    record: nativeShellLifetimeRecord,
    kernelEmpty: z.literal(true),
    neverLaunched: z.literal(true).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.neverLaunched &&
      (value.scope !== "verified-windows-atomic-job-v2" ||
        value.record.origin.runAuthorized ||
        value.record.origin.helperPid !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Never-launched closure requires an unstarted Windows reservation"
      })
    if (value.scope !== value.record.resource.kind)
      context.addIssue({
        code: "custom",
        message: "Native closure scope differs from actual resource"
      })
  })
export type NativeShellClosure = z.infer<typeof nativeShellClosure>
export function sameNativeOrigin(
  expected: NativeShellLifetimeRecord,
  actual: NativeShellLifetimeRecord
): boolean {
  const project = (record: NativeShellLifetimeRecord) => {
    const origin = Object.fromEntries(
      Object.entries(record.origin).filter(
        ([key]) => !["phase", "runAuthorized", "helperPid", "workerPid"].includes(key)
      )
    )
    // No result/status/phase can make this identity less strict. The writer is
    // independent of the mutable authorization/diagnostic PID fields.
    return { origin, resource: record.resource }
  }
  return JSON.stringify(project(expected)) === JSON.stringify(project(actual))
}
