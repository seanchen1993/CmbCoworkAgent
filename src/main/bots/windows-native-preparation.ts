import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { compileBotPlatformPreparation, type BotPlatformRootPin } from "./bot-strict-platform"
import { nativeShellPlan, type NativeShellPlan } from "./native-shell-contract"
import type { VerifiedNativeShellPackage } from "./native-shell-package"

export interface WindowsBotNativeConfiguration {
  packageDirectory: string
  manifestSha256: string
  resourceLimits?: { pids: number; memoryBytes: number }
}

/** Shared by shell and persistent desktop startup. None of these arguments is
 * an approval, a command receipt, or a verdict that Windows isolation passed. */
export const insideWindowsNativeRoot = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return (
    part === "" ||
    (part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part))
  )
}
export async function pinWindowsNativeRoot(path: string): Promise<BotPlatformRootPin> {
  const canonical = await realpath(path),
    current = await lstat(canonical, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error("Bot native directory is invalid")
  return { path: canonical, dev: String(current.dev), ino: String(current.ino) }
}
export async function assertWindowsNativeRoot(pin: BotPlatformRootPin): Promise<void> {
  const current = await pinWindowsNativeRoot(pin.path)
  if (current.path !== pin.path || current.dev !== pin.dev || current.ino !== pin.ino)
    throw new Error("Bot native directory changed")
}
function uniqueRoots(roots: BotPlatformRootPin[]): BotPlatformRootPin[] {
  const result = new Map<string, BotPlatformRootPin>()
  for (const root of roots) {
    const existing = result.get(root.path)
    if (existing && (existing.dev !== root.dev || existing.ino !== root.ino))
      throw new Error("Bot native root identities conflict")
    result.set(root.path, root)
  }
  return [...result.values()]
}
export async function compileTrustedWindowsNativePreparation(input: {
  pkg: VerifiedNativeShellPackage
  codexHome: string
  cwd: string
  workspace: BotPlatformRootPin
  readRoots: BotPlatformRootPin[]
  writeRoots: BotPlatformRootPin[]
  deniedRoots: BotPlatformRootPin[]
  codeRoots: BotPlatformRootPin[]
  hostId: string
  dataEpoch: string
}): Promise<{
  plan: NativeShellPlan
  profile: Awaited<ReturnType<typeof compileBotPlatformPreparation>>["profile"]
}> {
  if (process.platform !== "win32" || input.pkg.manifest.platform !== "win32")
    throw new Error("Windows native preparation requires Windows")
  const readRoots = uniqueRoots(input.readRoots),
    writeRoots = uniqueRoots(input.writeRoots),
    deniedRoots = uniqueRoots(input.deniedRoots)
  // A writable ancestor can modify runtime code just as a writable child can.
  // Neither shell nor GUI preparation grants either overlap.
  for (const write of writeRoots)
    for (const code of input.codeRoots)
      if (
        insideWindowsNativeRoot(code.path, write.path) ||
        insideWindowsNativeRoot(write.path, code.path)
      )
        throw new Error("Bot workspace must not overlap installed runtime code")
  const preparation = await compileBotPlatformPreparation(
    {
      platform: "win32",
      arch: process.arch,
      cwd: input.workspace,
      readRoots,
      writeRoots,
      deniedRoots,
      network: true,
      capability: {
        filesystem: "codex-windows-elevated-split-v1",
        lifetime: "verified-windows-atomic-job-v2",
        readDeny: false,
        controlChannelDeny: false,
        kernelProbe: "source-only",
        helperSha256: input.pkg.nativeHelper.sha256,
        sourceRevision: input.pkg.manifest.revision,
        helperProtocol: input.pkg.manifest.protocol,
        elevatedSetup: "unconfigured"
      }
    },
    {
      platform: "win32",
      arch: process.arch,
      inside: insideWindowsNativeRoot,
      toFileURL: (path) => pathToFileURL(path).href,
      assertPinned: assertWindowsNativeRoot
    }
  )
  const policyValue = JSON.parse(preparation.policy)
  policyValue.sandboxCwd = pathToFileURL(input.cwd).href
  const policy = JSON.stringify(policyValue)
  const plan = nativeShellPlan.parse({
    format: 1,
    platform: "win32",
    arch: process.arch,
    revision: input.pkg.manifest.revision,
    cli: input.pkg.cli,
    nativeHelper: input.pkg.nativeHelper,
    codexHome: input.codexHome,
    cwd: input.cwd,
    startupCwd: input.workspace.path,
    policy,
    policySha256: createHash("sha256").update(policy).digest("hex"),
    roots: preparation.pins,
    artifactPins: input.pkg.artifactPins,
    preparationBinding: createHash("sha256")
      .update(
        JSON.stringify({
          manifest: input.pkg.manifestSha256,
          policy: preparation.profile.policySha256,
          hostId: input.hostId,
          dataEpoch: input.dataEpoch
        })
      )
      .digest("hex")
  })
  return { plan, profile: preparation.profile }
}

export async function compileTrustedWindowsNativePlan(
  input: Parameters<typeof compileTrustedWindowsNativePreparation>[0]
): Promise<NativeShellPlan> {
  return (await compileTrustedWindowsNativePreparation(input)).plan
}

/** Reuse Cmb's existing immutable-entry module discovery. Only the actual
 * installation's node_modules directory is readable; neither the source root
 * nor global NODE_PATH directories become a grant. Resolving the marker's
 * physical path also keeps pnpm's internal package store inside the same pin. */
export async function windowsNativeModuleRoots(
  entries: readonly string[]
): Promise<BotPlatformRootPin[]> {
  const roots: BotPlatformRootPin[] = []
  for (const entry of [...new Set(entries)]) {
    if (!isAbsolute(entry)) throw new Error("Bot native module entry is not absolute")
    const modules = await realpath(createRequire(entry).resolve("zod/package.json"))
    let cursor = dirname(entry),
      found = false
    for (let depth = 0; depth < 64; depth++) {
      try {
        const root = await pinWindowsNativeRoot(join(cursor, "node_modules"))
        if (insideWindowsNativeRoot(root.path, modules)) {
          roots.push(root)
          found = true
          break
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const next = dirname(cursor)
      if (next === cursor) break
      cursor = next
    }
    if (!found) throw new Error("Bot native modules are outside the installed module directory")
  }
  return uniqueRoots(roots)
}

/** Preserve Cmb's existing executable discovery roots without authorizing the
 * entire filesystem or silently ignoring malformed/inaccessible directories. */
export async function windowsNativeToolRoots(): Promise<BotPlatformRootPin[]> {
  const paths = [
    ...new Set(
      (process.env.PATH ?? "").split(";").filter((path) => isAbsolute(path) && path !== "/")
    )
  ]
  if (paths.length > 32) throw new Error("Bot native PATH authorization exceeds its limit")
  const roots: BotPlatformRootPin[] = []
  for (const path of paths) {
    try {
      const root = await pinWindowsNativeRoot(path)
      if (root.path !== "/") roots.push(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return uniqueRoots(roots)
}

/** Exact fixed Codex 954fa905 setup.rs WINDOWS_PLATFORM_DEFAULT_READ_ROOTS.
 * The compiler's existing `special:minimal` already grants these Windows-only
 * reads; making the set explicit also lets the GUI launch facade check it.
 * UserProfile/AppData are not part of this platform default. */
export async function windowsNativeDefaultReadRoots(): Promise<BotPlatformRootPin[]> {
  const roots: BotPlatformRootPin[] = []
  for (const path of [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData"
  ]) {
    try {
      roots.push(await pinWindowsNativeRoot(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return uniqueRoots(roots)
}
