import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

export type BotPlatform = "darwin" | "win32" | "linux"
export interface BotPlatformRootPin {
  path: string
  dev: string
  ino: string
}
/** This is supplied by private native startup probes plus the verified package
 * manifest. It is not a user preference, model argument or static OS guess. */
export interface BotPlatformCapability {
  filesystem: string
  lifetime: string
  readDeny: boolean
  controlChannelDeny: boolean
  kernelProbe: "passed" | "source-only" | "unavailable"
  helperSha256?: string
  sourceRevision?: string
  helperProtocol?: string
  elevatedSetup?: "complete" | "unconfigured"
  linuxHelperPath?: string
  linuxHelperSha256?: string
  bwrapSha256?: string
  arbitraryDaemonContainment?: boolean
}
export interface BotPlatformCompileInput {
  platform: BotPlatform
  arch: string
  cwd: BotPlatformRootPin
  readRoots: BotPlatformRootPin[]
  writeRoots: BotPlatformRootPin[]
  deniedRoots: BotPlatformRootPin[]
  network: boolean
  requiresArbitraryDaemonContainment?: boolean
  capability: BotPlatformCapability
}
/** assertPinned reuses existing canonical workspace/skill-source fences,
 * including path declarations, intermediate links/junctions and Host epoch. */
export interface BotPlatformPaths {
  platform: BotPlatform
  arch: string
  assertPinned(root: BotPlatformRootPin): Promise<void>
  inside(root: string, path: string): boolean
  toFileURL(path: string): string
}

// Candidate: every input below comes from the trusted Host profile compiler;
// neither a model tool argument nor an old execution receipt can choose these.
export const PINNED_CODEX_REVISION = "954fa9057bf3a4521ea34dbd010ff291d5b39763"
const SHA = /^[a-f0-9]{64}$/
const controls = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}
const BACKENDS: Record<BotPlatform, { filesystem: string; lifetime: string }> = {
  darwin: { filesystem: "macos-seatbelt-v1", lifetime: "owned-controlled-process-group" },
  win32: {
    filesystem: "codex-windows-elevated-split-v1",
    lifetime: "verified-windows-atomic-job-v2"
  },
  linux: { filesystem: "codex-linux-bwrap-split-v1", lifetime: "verified-linux-cgroup-v2" }
}
export class BotPlatformUnavailable extends Error {
  constructor(
    readonly code: string,
    reason: string
  ) {
    super(reason)
  }
}
const unavailable = (reason: string): never => {
  throw new BotPlatformUnavailable("bot_platform_unavailable", reason)
}
function boundedRoots(
  roots: BotPlatformRootPin[],
  label: string,
  maximum: number
): BotPlatformRootPin[] {
  if (!Array.isArray(roots) || roots.length > maximum) unavailable(`${label} 数量超过上限`)
  for (const root of roots) {
    if (
      !root ||
      typeof root.path !== "string" ||
      root.path.length > 4096 ||
      controls(root.path) ||
      !/^\d+$/.test(root.dev) ||
      !/^\d+$/.test(root.ino)
    )
      unavailable(`${label} 缺少规范路径身份`)
  }
  return roots
}
/** Paths and ancestor identity checks stay behind this port so the existing
 * Windows junction and canonical project fences are reused, not reimplemented.
 * Returned pins are checked again immediately before effects. */
export async function compileBotPlatformPlan(
  input: BotPlatformCompileInput,
  paths: BotPlatformPaths
) {
  return compilePlatformPolicy(input, paths, false)
}
/** Compiles only an unadmitted private policy for the fixed first-use probe.
 * It never returns a runtime capability or substitutes for that probe. */
export async function compileBotPlatformPreparation(
  input: BotPlatformCompileInput,
  paths: BotPlatformPaths
) {
  if (!["linux", "win32"].includes(input.platform))
    unavailable("Native preparation requires a native provider")
  return compilePlatformPolicy(input, paths, true)
}
async function compilePlatformPolicy(
  input: BotPlatformCompileInput,
  paths: BotPlatformPaths,
  preparationOnly: boolean
) {
  const expected = BACKENDS[input.platform]
  if (!expected || input.arch !== paths.arch || input.platform !== paths.platform)
    unavailable("执行平台与本机不一致")
  if (typeof input.network !== "boolean") unavailable("Bot 网络授权无效")
  boundedRoots([input.cwd], "工作目录", 1)
  const read = boundedRoots(input.readRoots, "只读目录", 64),
    write = boundedRoots(input.writeRoots, "可写目录", 32),
    deny = boundedRoots(input.deniedRoots, "受保护目录", 16)
  const cap = input.capability
  if (
    !cap ||
    cap.filesystem !== expected.filesystem ||
    cap.lifetime !== expected.lifetime ||
    (!preparationOnly &&
      (cap.readDeny !== true || cap.controlChannelDeny !== true || cap.kernelProbe !== "passed"))
  )
    unavailable("当前系统尚未通过 Bot 命令隔离检查")
  if (input.platform !== "darwin" && cap.helperProtocol !== "codex-cmb-owned-sandbox-v1")
    unavailable("Bot 沙箱组件启动协议不匹配")
  if (input.platform === "win32" && !preparationOnly && cap.elevatedSetup !== "complete")
    unavailable("请先完成 Bot 管理员沙箱初始化")
  if (
    input.platform !== "darwin" &&
    (!SHA.test(cap.helperSha256 ?? "") || cap.sourceRevision !== PINNED_CODEX_REVISION)
  )
    unavailable("Bot 沙箱组件版本未核对")
  if (
    input.platform === "linux" &&
    (!cap.linuxHelperPath ||
      !cap.linuxHelperPath.startsWith("/") ||
      controls(cap.linuxHelperPath) ||
      !SHA.test(cap.linuxHelperSha256 ?? "") ||
      !SHA.test(cap.bwrapSha256 ?? ""))
  )
    unavailable("Linux 命令隔离组件尚未核对")
  if (input.requiresArbitraryDaemonContainment && cap.arbitraryDaemonContainment !== true)
    unavailable("当前系统不支持此任务所需的独立守护进程收口")
  for (const root of [...read, ...write, ...deny, input.cwd]) await paths.assertPinned(root)
  for (const root of [input.cwd, ...write, ...read])
    for (const blocked of deny) {
      if (paths.inside(blocked.path, root.path))
        unavailable("项目或可写目录位于 Bot 后台受保护目录中")
    }
  const entries = [
    { path: { type: "special", value: { kind: "minimal" } }, access: "read" },
    ...read.map((root) => ({ path: { type: "path", path: root.path }, access: "read" })),
    ...write.map((root) => ({ path: { type: "path", path: root.path }, access: "write" })),
    ...deny.map((root) => ({ path: { type: "path", path: root.path }, access: "deny" }))
  ]
  const state = {
    permissionProfile: {
      type: "managed",
      file_system: { type: "restricted", entries },
      network: input.network ? "enabled" : "restricted"
    },
    codexLinuxSandboxExe: input.platform === "linux" ? cap.linuxHelperPath : null,
    sandboxCwd: paths.toFileURL(input.cwd.path),
    useLegacyLandlock: false
  }
  const policy = JSON.stringify(state)
  if (Buffer.byteLength(policy) > 64 * 1024) unavailable("Bot 目录授权超过策略长度上限")
  const pins = [...read, ...write, ...deny, input.cwd].map((root) =>
    Object.freeze({ path: root.path, dev: root.dev, ino: root.ino })
  )
  const authority = {
    format: 2,
    platform: input.platform,
    arch: input.arch,
    filesystem: expected.filesystem,
    lifetime: expected.lifetime,
    helperSha256: cap.helperSha256 ?? null,
    sourceRevision: cap.sourceRevision ?? null,
    linuxHelperSha256: cap.linuxHelperSha256 ?? null,
    bwrapSha256: cap.bwrapSha256 ?? null,
    filesystemPolicySha256: createHash("sha256").update(policy).digest("hex"),
    arbitraryDaemonContainment: cap.arbitraryDaemonContainment === true
  }
  const profile = {
    ...authority,
    policySha256: createHash("sha256").update(JSON.stringify({ authority, pins })).digest("hex")
  }
  return Object.freeze({ profile: Object.freeze(profile), policy, pins: Object.freeze(pins) })
}
export function codexSandboxArguments(
  plan: Awaited<ReturnType<typeof compileBotPlatformPlan>>,
  command: string[],
  os: BotPlatform
) {
  if (plan.profile.platform !== os || os === "darwin") unavailable("平台启动器不匹配")
  if (
    !command.length ||
    command.length > 130 ||
    command.some((a) => typeof a !== "string" || a.includes("\0"))
  )
    unavailable("Bot 命令参数无效")
  const args = [
    "-c",
    'shell_environment_policy.inherit="all"',
    "-c",
    "shell_environment_policy.ignore_default_excludes=true",
    "-c",
    "shell_environment_policy.exclude=[]",
    "-c",
    "shell_environment_policy.include_only=[]",
    ...(os === "win32" ? ["-c", 'windows.sandbox="elevated"'] : []),
    "sandbox",
    os === "win32" ? "windows" : "linux",
    "--sandbox-state-json",
    plan.policy,
    "--",
    ...command
  ]
  if (os === "win32" && args.reduce((n, a) => n + windowsArgument(a).length + 1, 1024) > 32767)
    unavailable("命令及目录授权超过 Windows 启动参数上限，请缩小本次授权范围")
  return args
}
function windowsArgument(value: string) {
  if (!value.length) return '""'
  if (!/[\s"]/u.test(value)) return value
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"'
}
export const nativeFileURL = pathToFileURL
