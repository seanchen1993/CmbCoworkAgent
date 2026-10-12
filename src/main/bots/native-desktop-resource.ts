import { z } from "zod"
import { createHash } from "node:crypto"
import { nativeShellPlan, nativeShellArtifact, type NativeShellPlan } from "./native-shell-contract"
import { windowsBotJobScope } from "./windows-native-contract"
import { nativeDesktopScope } from "../../shared/bot-native-desktop"
import { canonicalJson } from "./validation"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const directoryPin = z
  .object({
    path: z.string().min(1).max(4096),
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/)
  })
  .strict()
/** A persistent GUI resource is not a shell command and never fabricates a
 * ShellAction/run-authorized receipt to borrow command admission. */
export const nativeDesktopResourceRecord = z
  .object({
    format: z.literal(1),
    kind: z.literal("cmb-native-desktop-resource-v1"),
    ownerProtocol: z.literal("cmb-native-desktop-owner-v1"),
    nonce: z.string().uuid(),
    scope: nativeDesktopScope,
    packageManifestSha256: digest,
    policySha256: digest,
    bootstrap: nativeShellArtifact,
    worker: nativeShellArtifact,
    directory: directoryPin,
    scratchDirectory: directoryPin.optional(),
    resource: windowsBotJobScope
  })
  .strict()
  .refine(
    (record) => record.nonce === record.resource.nonce,
    "Desktop nonce differs from actual Job"
  )
export type NativeDesktopResourceRecord = z.infer<typeof nativeDesktopResourceRecord>
export const nativeDesktopResourceClosure = z
  .object({
    format: z.literal(1),
    kind: z.literal("cmb-native-desktop-closure-v1"),
    record: nativeDesktopResourceRecord,
    kernelEmpty: z.literal(true)
  })
  .strict()
export const nativeDesktopBootstrapConfiguration = z
  .object({
    type: z.literal("configure"),
    protocol: z.literal("cmb-native-desktop-bootstrap-v1"),
    version: z.literal(1),
    nonce: z.string().uuid(),
    scope: nativeDesktopScope,
    packageDirectory: z.string().min(1).max(4096),
    manifestSha256: digest,
    bootstrap: nativeShellArtifact,
    nativePlan: nativeShellPlan,
    runtimeMode: z.literal("readonly-installed"),
    scratchDirectory: z.string().min(1).max(4096),
    probe: z
      .object({
        readSentinel: z.string().min(1).max(4096),
        deniedWrite: z.string().min(1).max(4096),
        controlChannel: z.string().min(1).max(4096),
        releaseFile: z.string().min(1).max(4096)
      })
      .strict()
  })
  .strict()
export type NativeDesktopBootstrapConfiguration = z.infer<
  typeof nativeDesktopBootstrapConfiguration
>
export const nativeDesktopBootstrapHello = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal("cmb-native-desktop-bootstrap-v1"),
    version: z.literal(1),
    nonce: z.string().uuid(),
    bootstrapPid: z.number().int().positive().max(0x7fffffff),
    token: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

/** Projects only the existing managed split policy. It never derives directory
 * permissions from argv, an app title, a model argument, or a renderer payload. */
export function nativeDesktopPolicyRoots(raw: NativeShellPlan): {
  readRoots: string[]
  writeRoots: string[]
} {
  const plan = nativeShellPlan.parse(raw)
  if (
    plan.platform !== "win32" ||
    createHash("sha256").update(plan.policy).digest("hex") !== plan.policySha256
  )
    throw new Error("Desktop native policy identity differs")
  const value = JSON.parse(plan.policy)
  if (
    value.permissionProfile?.type !== "managed" ||
    value.permissionProfile.file_system?.type !== "restricted" ||
    value.useLegacyLandlock !== false ||
    !Array.isArray(value.permissionProfile.file_system.entries)
  )
    throw new Error("Desktop requires the existing strict managed split policy")
  const read = new Set<string>(),
    write = new Set<string>()
  for (const entry of value.permissionProfile.file_system.entries) {
    if (entry.path?.type !== "path") continue
    const path = entry.path.path
    if (
      typeof path !== "string" ||
      !/^[A-Za-z]:\\/.test(path) ||
      path.length > 4096 ||
      path.includes("\0") ||
      !plan.roots.some((pin) => pin.path === path)
    )
      throw new Error("Desktop policy path is not a pinned local root")
    if (entry.access === "read" || entry.access === "write") read.add(path)
    if (entry.access === "write") write.add(path)
    if (!["read", "write", "deny"].includes(entry.access))
      throw new Error("Invalid desktop policy access")
  }
  if (read.size > 64 || write.size > 64) throw new Error("Desktop policy roots exceed their bounds")
  return { readRoots: [...read], writeRoots: [...write] }
}
export function sameNativeDesktopResource(
  expected: NativeDesktopResourceRecord,
  actual: NativeDesktopResourceRecord
): boolean {
  return canonicalJson(expected) === canonicalJson(actual)
}
