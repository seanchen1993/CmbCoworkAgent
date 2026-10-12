import { z } from "zod"
import { PINNED_CODEX_REVISION } from "./bot-strict-platform"
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const nativeShellArtifact = z.object({ entry: path, sha256: digest }).strict()
export const nativeShellFilePin = z
  .object({
    entry: path,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    size: z.string().regex(/^\d+$/),
    mtimeNs: z.string().regex(/^\d+$/),
    ctimeNs: z.string().regex(/^\d+$/)
  })
  .strict()
export const nativeShellRootPin = z
  .object({ path, dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict()
/** Trusted package/policy metadata. Passed only across the authenticated owner
 * IPC, never embedded in public shell arguments or inherited model env. */
export const nativeShellPlan = z
  .object({
    format: z.literal(1),
    platform: z.enum(["win32", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    revision: z.literal(PINNED_CODEX_REVISION),
    cli: nativeShellArtifact,
    nativeHelper: nativeShellArtifact,
    bwrap: nativeShellArtifact.optional(),
    codexHome: path,
    cwd: path,
    startupCwd: path,
    policy: z
      .string()
      .min(1)
      .max(64 * 1024),
    policySha256: digest,
    roots: z.array(nativeShellRootPin).min(1).max(128),
    artifactPins: z.array(nativeShellFilePin).min(3).max(96),
    preparationBinding: digest
  })
  .strict()
export type NativeShellPlan = z.infer<typeof nativeShellPlan>
export const nativeShellPackage = z
  .object({
    format: z.literal(1),
    platform: z.enum(["win32", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    revision: z.literal(PINNED_CODEX_REVISION),
    protocol: z.enum(["codex-sandbox-state-v1", "codex-cmb-owned-sandbox-v1"]),
    patchSha256: digest.optional(),
    ownerProtocol: z.literal("cmb-atomic-windows-job-v2").optional(),
    desktopOwnerProtocol: z.literal("cmb-native-desktop-owner-v1").optional(),
    desktopWorker: z
      .object({
        name: z.literal("CMBDevClaw.NativeDesktop.exe"),
        sha256: digest,
        runtimeMode: z.literal("readonly-installed"),
        assets: z.array(z.object({
          name: z.string().max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
          sha256: digest
        }).strict()).min(1).max(64)
      })
      .strict()
      .optional(),
    jobOwner: z
      .object({ name: z.literal("bot-resource-owner.exe"), sha256: digest })
      .strict()
      .optional(),
    cli: z.object({ name: z.enum(["codex.exe", "codex"]), sha256: digest }).strict(),
    helper: z
      .object({ name: z.enum(["codex-command-runner.exe", "codex-linux-sandbox"]), sha256: digest })
      .strict(),
    setup: z
      .object({ name: z.literal("codex-windows-sandbox-setup.exe"), sha256: digest })
      .strict()
      .optional(),
    bwrap: z
      .object({ name: z.literal("bwrap"), sha256: digest })
      .strict()
      .optional(),
    sourceArchive: z.object({ name: z.literal("native-sources.tgz"), sha256: digest }).strict(),
    licenses: z
      .array(
        z
          .object({
            name: z.enum([
              "CODEX-LICENSE",
              "CODEX-NOTICE",
              "BWRAP-LICENSE",
              "CMB-LICENSE",
              "WINAPP-LICENSE"
            ]),
            sha256: digest
          })
          .strict()
      )
      .min(3)
      .max(4)
  })
  .strict()
  .superRefine((value, context) => {
    const members = [value.cli, value.helper, value.setup, value.jobOwner,
      value.desktopWorker, ...(value.desktopWorker?.assets ?? []), value.bwrap,
      value.sourceArchive, ...value.licenses].filter((member) => member !== undefined)
    if (new Set(members.map((member) => member.name)).size !== members.length)
      context.addIssue({ code: "custom", message: "Native package contains duplicate members" })
    const names = value.licenses.map((item) => item.name)
    const expectedLicenses =
      value.platform === "linux"
        ? ["CODEX-LICENSE", "CODEX-NOTICE", "BWRAP-LICENSE"]
        : [
            "CODEX-LICENSE",
            "CODEX-NOTICE",
            "CMB-LICENSE",
            ...(value.desktopWorker ? ["WINAPP-LICENSE"] : [])
          ]
    if (
      names.length !== expectedLicenses.length ||
      new Set(names).size !== names.length ||
      expectedLicenses.some((name) => !names.includes(name as (typeof names)[number]))
    )
      context.addIssue({
        code: "custom",
        message: "Native package license provenance is incomplete"
      })

    if (
      value.platform === "win32" &&
      (!value.setup ||
        !value.jobOwner ||
        !value.ownerProtocol ||
        !value.patchSha256 ||
        value.protocol !== "codex-cmb-owned-sandbox-v1" ||
        value.cli.name !== "codex.exe" ||
        value.helper.name !== "codex-command-runner.exe" ||
        value.bwrap)
    )
      context.addIssue({ code: "custom", message: "Invalid Windows native package" })
    if (
      value.platform === "linux" &&
      (!value.bwrap ||
        value.cli.name !== "codex" ||
        value.helper.name !== "codex-linux-sandbox" ||
        value.setup ||
        value.jobOwner ||
        value.ownerProtocol ||
        value.desktopOwnerProtocol ||
        value.desktopWorker ||
        !value.patchSha256 ||
        value.protocol !== "codex-cmb-owned-sandbox-v1")
    )
      context.addIssue({ code: "custom", message: "Invalid Linux native package" })
    if (value.desktopWorker && !value.desktopOwnerProtocol)
      context.addIssue({
        code: "custom",
        message: "Native desktop worker requires the fixed desktop owner protocol"
      })
    if (value.desktopWorker && ["DOTNET-RUNTIME-LICENSE.TXT", "DOTNET-RUNTIME-THIRD-PARTY-NOTICES.TXT", "DOTNET-WINDOWSDESKTOP-LICENSE.TXT"].some(
      (name) => !value.desktopWorker!.assets.some((member) => member.name === name)))
      context.addIssue({code: "custom", message: "Native desktop runtime notices are incomplete"})
  })
export type NativeShellPackage = z.infer<typeof nativeShellPackage>
/** Actual runtime verdict is bound to the immutable package and current roots.
 * Persistent JSON or static source-only support is never a native admission. */
export const nativeShellProbeResult = z
  .object({
    platform: z.enum(["win32", "linux"]),
    binding: digest,
    readDeny: z.literal(true),
    writeDeny: z.literal(true),
    controlChannelDeny: z.literal(true),
    lifetime: z.enum(["verified-windows-atomic-job-v2", "verified-linux-cgroup-v2"]),
    setup: z.enum(["complete", "not-required"])
  })
  .strict()
export type NativeShellProbeResult = z.infer<typeof nativeShellProbeResult>

export const nativeShellWorkerConfiguration = z
  .object({
    nativePlan: nativeShellPlan,
    probe: z
      .object({
        nonce: z.string().uuid(),
        readSentinel: path,
        deniedWrite: path,
        controlChannel: path,
        releaseFile: path.optional()
      })
      .strict()
  })
  .strict()
