/**
 * Pty Host — 独立子进程，管理所有 node-pty 实例。
 * 避免 PTY I/O 阻塞主进程事件循环。
 * 通过 process.send / process.on("message") 与主进程通信。
 *
 * 关键 invariant（terminal.ts 的代际守卫依赖这条契约）：
 * - 文件初始化期间（顶层 import 副作用、模块代码执行）只允许在最末尾发 send({type:"ready"})。
 * - 在 ready 之前不要主动发 created/data/exit/error+id 等带 PTY id 的消息，否则旧代 stuck host
 *   被 kill 时若 IPC 还没刷干净，可能污染主进程下一代 host 的 pendingCreates / ptyWindows。
 * - uncaughtException handler 发的 {type:"error"}（无 id）落在 terminal.ts 的全局 error 分支，安全。
 *
 * 另一条契约（disposeAll 流程）：
 * - process.on("disconnect") 必须保留并兜底调 handleDisposeAll，因为 terminal.ts 的 500ms kill
 *   fallback 在 will-quit 之后不保证执行。删掉 disconnect handler 会出孤儿子进程。
 */
import { spawn as ptySpawn, IPty } from "node-pty"
import { platform, homedir } from "os"
import { existsSync } from "fs"
import { join, basename } from "path"
import { execFile, ChildProcess } from "child_process"
import {
  PTY_CREATE_CANCELLED_MESSAGE,
  PTY_CREATE_CANCELLED_TAG,
  PTY_DISPOSE_TIMED_OUT_MESSAGE
} from "./pty-protocol"

const activePtys = new Map<string, IPty>()
const cancelledCreates = new Set<string>()
const creatingPtys = new Set<string>()
const createControllers = new Map<string, AbortController>()
const activeExecChildren = new Set<ChildProcess>()
const disposeWatchdogs = new Map<string, NodeJS.Timeout>()

// 流控：高低水位线，防止缓冲区溢出
const HIGH_WATER_MARK = 5 * 1024 * 1024  // 5MB 暂停
const LOW_WATER_MARK = 1 * 1024 * 1024   // 1MB 恢复
const pendingBytes = new Map<string, number>()
const paused = new Map<string, boolean>()
// 与主进程的 PTY_DISPOSE_TIMEOUT_MS 保持一致，避免 host 侧更早把“关闭慢”误报成不可恢复失败。
const DISPOSE_CONFIRM_TIMEOUT_MS = 15_000

// checkNodeVersion 与 tryCandidate 共享的"版本不兼容"标识：
// 用 sentinel 前缀而非 err.message.includes(...) 字符串匹配，避免改文案时漏改导致分类静默走错路径
const NODE_INCOMPATIBLE_TAG = "[NODE_INCOMPATIBLE] "
const NODE_TIMEOUT_TAG = "[NODE_TIMEOUT] "
// Windows 下宁可慢一点也尽量找到可用 Node：
// - 单次 node -v probe 固定 5s
// - Node where/reg 查找固定 3s
// - Git Bash 探测：where git 5s，注册表 3s
// 不再用“主预算 + tail 宽限”提前放弃后置候选。
const NODE_VERSION_PROBE_TIMEOUT_MS = 5_000
const NODE_DISCOVERY_LOOKUP_TIMEOUT_MS = 3_000
const GIT_SHELL_WHERE_TIMEOUT_MS = 5_000
const GIT_SHELL_REG_TIMEOUT_MS = 3_000

// 剥离 BOM 并 trim
function stripBomTrim(s: string): string {
  return s.replace(/^\uFEFF/, "").trim()
}

// 展开 REG_EXPAND_SZ 中的 %ENV% 引用
function expandEnvVars(s: string): string {
  return s.replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`)
}

// Windows-only helper for de-duplicating discovered node.exe paths.
function canonicalizeWinPath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase()
}

function getExecErrorInfo(err: unknown): {
  code: string
  exitCode: number | null
  status: number | null
  signal: string
  killed: boolean
  stdout: string
  stderr: string
  message: string
} {
  const code =
    typeof err === "object" && err && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : ""
  const exitCode =
    typeof err === "object" &&
    err &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "number"
      ? (err as { code: number }).code
      : null
  const status =
    typeof err === "object" &&
    err &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : null
  const signal =
    typeof err === "object" && err && "signal" in err
      ? String((err as { signal?: unknown }).signal ?? "")
      : ""
  const killed =
    typeof err === "object" && err && "killed" in err
      ? Boolean((err as { killed?: unknown }).killed)
      : false
  const stdout =
    typeof err === "object" && err && "stdout" in err
      ? String((err as { stdout?: unknown }).stdout ?? "")
      : ""
  const stderr =
    typeof err === "object" && err && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : ""
  const message = err instanceof Error ? err.message : String(err)
  return {
    code,
    exitCode,
    status,
    signal,
    killed,
    stdout,
    stderr,
    message
  }
}

function isExecTimeout(err: unknown): boolean {
  const { code, signal, killed } = getExecErrorInfo(err)
  return code === "ETIMEDOUT" || (killed && signal === "SIGTERM")
}

function isExecAbort(err: unknown): boolean {
  const { code } = getExecErrorInfo(err)
  return code === "ABORT_ERR" || (err instanceof Error && err.name === "AbortError")
}

function isCreateCancelled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.startsWith(PTY_CREATE_CANCELLED_TAG)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
}

async function execFileTracked(
  file: string,
  args: readonly string[],
  opts: {
    encoding: "utf8"
    windowsHide?: boolean
    timeout?: number
    signal?: AbortSignal
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, opts, (err, stdout, stderr) => {
      activeExecChildren.delete(child)
      if (err) {
        if (typeof err === "object" && err) {
          if (!("stdout" in err)) (err as { stdout?: unknown }).stdout = stdout
          if (!("stderr" in err)) (err as { stderr?: unknown }).stderr = stderr
        }
        reject(err)
        return
      }
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      })
    })
    activeExecChildren.add(child)
  })
}

let cachedShell: string | null = null
async function getShell(signal?: AbortSignal): Promise<string> {
  if (cachedShell) return cachedShell
  if (platform() === "win32") {
    const triedPaths: string[] = []

    // Git Bash：POSIX 兼容，ConPTY 正常，子进程 stdin 是真 TTY
    // 1. 快速检查常见路径（便宜：只是 stat 调用）
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "D:\\Program Files\\Git\\bin\\bash.exe",
      "D:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "D:\\Git\\bin\\bash.exe",
      join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    ]
    for (const p of candidates) {
      throwIfAborted(signal)
      triedPaths.push(p)
      if (existsSync(p)) {
        cachedShell = p
        return cachedShell
      }
    }

    // 2. where git 推导 bash 路径（git.exe 在 PATH 中的概率比 bash.exe 高）
    // 多个 git.exe 共存时（portable shim + 完整安装等），逐个尝试推导，直到找到带 bash.exe 的那个
    try {
      throwIfAborted(signal)
      const { stdout: gitOut } = await execFileTracked("where.exe", ["git"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: GIT_SHELL_WHERE_TIMEOUT_MS,
        signal
      })
      const gitExes = stripBomTrim(gitOut)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.toLowerCase().includes("system32"))
      if (gitExes.length === 0) {
        triedPaths.push("where:not-found")
      }
      for (const gitExe of gitExes) {
        const derivedBash = join(gitExe, "..", "..", "bin", "bash.exe")
        triedPaths.push(`where:${derivedBash}`)
        if (existsSync(derivedBash)) {
          cachedShell = derivedBash
          return cachedShell
        }
      }
    } catch (err) {
      if (isCreateCancelled(err)) throw err
      if (isExecAbort(err)) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
      const { exitCode, status } = getExecErrorInfo(err)
      if (isExecTimeout(err)) {
        triedPaths.push("where:timeout")
      } else if (exitCode === 1 || status === 1) {
        // where.exe 未命中时在不同系统语言下会输出本地化文案，统一按 status=1 视为 not-found。
        triedPaths.push("where:not-found")
      } else {
        triedPaths.push("where:failed")
      }
    }

    // 3. 注册表兜底（覆盖任意安装路径，git 不在 PATH 时仍可定位）
    const regKeys = [
      "HKLM\\SOFTWARE\\GitForWindows",
      "HKCU\\SOFTWARE\\GitForWindows"
    ]
    for (const key of regKeys) {
      try {
        throwIfAborted(signal)
        const { stdout: regOut } = await execFileTracked("reg", ["query", key, "/v", "InstallPath"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: GIT_SHELL_REG_TIMEOUT_MS,
          signal
        })
        // 兼容 REG_SZ 和 REG_EXPAND_SZ
        const match = /InstallPath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(regOut)
        if (match) {
          const installDir = expandEnvVars(stripBomTrim(match[1]))
          const regBash = join(installDir, "bin", "bash.exe")
          triedPaths.push(`reg:${key}:${regBash}`)
          if (existsSync(regBash)) {
            cachedShell = regBash
            return cachedShell
          }
          console.warn(`[PtyHost] Registry found Git at ${installDir} but bash.exe not found`)
        }
      } catch (err) {
        if (isCreateCancelled(err)) throw err
        if (isExecAbort(err)) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
        const { exitCode, status } = getExecErrorInfo(err)
        if (isExecTimeout(err)) {
          triedPaths.push(`reg:${key}:timeout`)
          continue
        }
        if (exitCode === 1 || status === 1) {
          // reg query 对"键/值不存在"也会使用本地化输出，统一按 status=1 视为未命中。
          triedPaths.push(`reg:${key}:not-found`)
          continue
        }
        triedPaths.push(`reg:${key}:failed`)
      }
    }
    throw new Error(
      `Git Bash not found. Tried: ${triedPaths.join("; ")}. ` +
      `Please install Git for Windows: https://git-scm.com/download/win`
    )
  } else {
    // $SHELL 在 systemd service / 部分 su 场景下可能为空，需要兜底探测。
    // 顺序：$SHELL → /bin/zsh（macOS Catalina+ 默认存在）→ /bin/bash（Linux 主流默认）→ /bin/sh（POSIX 保底）
    // 不硬编码 /bin/zsh：Linux 发行版默认通常不带 zsh，硬编码会让 ptySpawn 立刻 ENOENT。
    const envShell = process.env.SHELL
    if (envShell && existsSync(envShell)) {
      cachedShell = envShell
    } else if (existsSync("/bin/zsh")) {
      cachedShell = "/bin/zsh"
    } else if (existsSync("/bin/bash")) {
      cachedShell = "/bin/bash"
    } else {
      cachedShell = "/bin/sh"
    }
  }
  return cachedShell
}

let cachedNodeExe: string | null = null
async function findNodeExe(signal?: AbortSignal): Promise<string> {
  if (platform() !== "win32") throw new Error("findNodeExe is Windows-only")
  if (cachedNodeExe) return cachedNodeExe
  const triedPaths: string[] = []
  const seenCandidatePaths = new Set<string>()

  // 1. 快速检查常见路径（便宜：只是 stat 调用）
  const candidates: string[] = []
  // nvm-windows 的活跃版本 symlink 通常在 NVM_SYMLINK（默认 C:\Program Files\nodejs）。
  // 这里仍然显式加入候选，后续会通过 seenCandidatePaths 做去重。
  const nvmSymlink = process.env.NVM_SYMLINK
  if (nvmSymlink) candidates.push(join(nvmSymlink, "node.exe"))
  candidates.push(
    join(homedir(), ".volta", "bin", "node.exe"),
    join(homedir(), "scoop", "apps", "nodejs", "current", "node.exe"),
    join("C:\\", "Program Files", "nodejs", "node.exe"),
    join("C:\\", "Program Files (x86)", "nodejs", "node.exe"),
    join("D:\\", "Program Files", "nodejs", "node.exe"),
    join("D:\\", "Program Files (x86)", "nodejs", "node.exe")
  )

  // 探测一个已存在的候选路径：校验通过则缓存返回 "ok"，否则返回失败原因。
  // 不在版本不兼容时立即抛出 —— 用户可能同时装了不兼容旧版和兼容新版，旧的不能否决整个搜索。
  // triedPaths 由外层统一记录，避免双 push 导致最终错误冗长。
  let incompatibleSeen: string | null = null
  let timeoutSeen: string | null = null
  let execFailedSeen: string | null = null
  let lookupFailedSeen: string | null = null
  type TryResult = "ok" | "incompatible" | "timeout" | "exec-failed" | "duplicate"
  const recordTimeout = (detail: string): void => {
    if (!timeoutSeen) timeoutSeen = detail
  }
  const recordLookupFailure = (detail: string): void => {
    if (!lookupFailedSeen) lookupFailedSeen = detail
  }
  const tryCandidate = async (p: string, label: string): Promise<TryResult> => {
    const key = canonicalizeWinPath(p)
    if (seenCandidatePaths.has(key)) {
      return "duplicate"
    }
    seenCandidatePaths.add(key)

    try {
      await checkNodeVersion(p, signal)
      cachedNodeExe = p
      return "ok"
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith(PTY_CREATE_CANCELLED_TAG)) {
        throw err
      }
      if (msg.startsWith(NODE_INCOMPATIBLE_TAG)) {
        // 用户向错误展示时去掉内部 sentinel 前缀
        const cleanMsg = msg.slice(NODE_INCOMPATIBLE_TAG.length)
        if (!incompatibleSeen) incompatibleSeen = `${label} (${p}): ${cleanMsg}`
        console.warn(`[PtyHost] Skipping ${label} (${p}): incompatible Node.js version, continuing search`)
        return "incompatible"
      }
      if (msg.startsWith(NODE_TIMEOUT_TAG)) {
        const cleanMsg = msg.slice(NODE_TIMEOUT_TAG.length)
        recordTimeout(`${label} (${p}): ${cleanMsg}`)
        console.warn(`[PtyHost] Skipping ${label} (${p}): Node.js probe timed out`)
        return "timeout"
      }
      if (!execFailedSeen) execFailedSeen = `${label} (${p}): ${msg}`
      console.warn(`[PtyHost] Skipping ${label} (${p}): ${msg}`)
      return "exec-failed"
    }
  }

  // 单条 triedPaths 的状态后缀，避免外层为同一个候选 push 两次
  const trySuffix = (r: TryResult): string =>
    r === "incompatible"
      ? ":incompatible"
      : r === "timeout"
        ? ":timeout"
        : r === "exec-failed"
          ? ":exec-failed"
          : r === "duplicate"
            ? ":skipped-duplicate"
            : ""

  for (const p of candidates) {
    throwIfAborted(signal)
    if (!existsSync(p)) {
      triedPaths.push(`${p}:not-exists`)
      continue
    }
    const r = await tryCandidate(p, "candidate")
    if (r === "ok") return cachedNodeExe!
    triedPaths.push(`${p}${trySuffix(r)}`)
  }

  // 2. where.exe 查找（PATH 中，可能有多个 node.exe：nvm / Scoop / MSI 共存）
  try {
    throwIfAborted(signal)
    const { stdout: out } = await execFileTracked("where.exe", ["node.exe"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: NODE_DISCOVERY_LOOKUP_TIMEOUT_MS,
      signal
    })
    const lines = stripBomTrim(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) {
      triedPaths.push("where:not-found")
    }
    for (const line of lines) {
      if (!existsSync(line)) {
        triedPaths.push(`where:${line}:not-exists`)
        continue
      }
      // label 不塞 path：tryCandidate 内部 warn 时已经会单独打 path，避免 "where:C:\...\node.exe (C:\...\node.exe)" 重复
      const r = await tryCandidate(line, "where")
      if (r === "ok") return cachedNodeExe!
      triedPaths.push(`where:${line}${trySuffix(r)}`)
    }
  } catch (err) {
    if (isCreateCancelled(err)) throw err
    if (isExecAbort(err)) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
    const { exitCode, status, message } = getExecErrorInfo(err)
    if (isExecTimeout(err)) {
      recordTimeout(`where.exe node.exe: lookup timed out`)
      triedPaths.push("where:timeout")
    } else if (exitCode === 1 || status === 1) {
      // where.exe 未命中 PATH 时在不同系统语言下会本地化，统一按 status=1 视为 not-found。
      triedPaths.push("where:not-found")
    } else {
      recordLookupFailure(`where.exe node.exe: ${message}`)
      triedPaths.push("where:exec-failed")
    }
  }

  // 3. 注册表兜底（Node.js MSI 安装会写 HKLM/HKCU SOFTWARE\Node.js InstallPath）
  const regKeys = [
    "HKLM\\SOFTWARE\\Node.js",
    "HKCU\\SOFTWARE\\Node.js",
    "HKLM\\SOFTWARE\\WOW6432Node\\Node.js"
  ]
  for (const key of regKeys) {
    try {
      throwIfAborted(signal)
      const { stdout: regOut } = await execFileTracked("reg", ["query", key, "/v", "InstallPath"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: NODE_DISCOVERY_LOOKUP_TIMEOUT_MS,
        signal
      })
      // 兼容 REG_SZ 和 REG_EXPAND_SZ
      const match = /InstallPath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(regOut)
      if (match) {
        const installDir = expandEnvVars(stripBomTrim(match[1]))
        const regNode = join(installDir, "node.exe")
        if (!existsSync(regNode)) {
          console.warn(`[PtyHost] Registry found Node.js at ${installDir} but node.exe not found`)
          triedPaths.push(`reg:${key}:${regNode}:not-exists`)
          continue
        }
        const r = await tryCandidate(regNode, `reg:${key}`)
        if (r === "ok") return cachedNodeExe!
        triedPaths.push(`reg:${key}:${regNode}${trySuffix(r)}`)
      }
    } catch (err) {
      if (isCreateCancelled(err)) throw err
      if (isExecAbort(err)) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
      const { exitCode, status, message } = getExecErrorInfo(err)
      if (isExecTimeout(err)) {
        recordTimeout(`reg query ${key}: lookup timed out`)
        triedPaths.push(`reg:${key}:timeout`)
        continue
      }
      if (exitCode === 1 || status === 1) {
        // reg query 对"键/值不存在"会返回 status=1，但输出文本会本地化，统一按未命中处理。
        triedPaths.push(`reg:${key}:not-found`)
        continue
      }
      recordLookupFailure(`reg query ${key}: ${message}`)
      triedPaths.push(`reg:${key}:exec-failed`)
    }
  }

  // 全部候选都失败：如果至少有一个候选是版本不兼容，优先报告"升级"，否则报告"找不到"
  // 错误消息只包含摘要（前 3 条 + 总数），完整列表打到日志，避免几 KB 的字符串塞进 IPC/弹窗
  const triedSummary = triedPaths.length <= 3
    ? triedPaths.join("; ")
    : `${triedPaths.slice(0, 3).join("; ")}; ... (+${triedPaths.length - 3} more)`
  console.error(`[PtyHost] findNodeExe failed. All tried paths:\n${triedPaths.join("\n")}`)

  const issueParts: string[] = []
  if (incompatibleSeen) {
    issueParts.push(`Incompatible versions: ${incompatibleSeen}.`)
  }
  if (timeoutSeen) {
    issueParts.push(`Timed out during background probing: ${timeoutSeen}.`)
  }
  if (execFailedSeen) {
    issueParts.push(`Failed to execute: ${execFailedSeen}.`)
  }
  if (lookupFailedSeen) {
    issueParts.push(`PATH/registry lookups failed: ${lookupFailedSeen}.`)
  }

  if (issueParts.length > 1) {
    const summaryLead =
      incompatibleSeen || execFailedSeen
        ? "Node.js found but not fully usable."
        : "Node.js detection encountered multiple probe/lookup issues."
    throw new Error(
      `${summaryLead} ${issueParts.join(" ")} Tried: ${triedSummary}. ` +
      `Upgrade Node.js and check endpoint protection/AppLocker rules: https://nodejs.org/`
    )
  }
  if (incompatibleSeen) {
    throw new Error(
      `All discovered Node.js installations are incompatible with Claude Code. ` +
      `First match: ${incompatibleSeen}. Tried: ${triedSummary}. ` +
      `Please upgrade: https://nodejs.org/`
    )
  }
  if (timeoutSeen) {
    throw new Error(
      `Node.js detection timed out during background probing. ` +
      `First issue: ${timeoutSeen}. ` +
      `Tried: ${triedSummary}. ` +
      `This usually means hidden child-process launches are being delayed or blocked on Windows.`
    )
  }
  if (execFailedSeen) {
    // node.exe 存在但无法执行（权限/AppLocker/架构不匹配/损坏），和"找不到"是完全不同的排查方向
    throw new Error(
      `Node.js found but could not be executed (permission/AppLocker/architecture/corruption). ` +
      `First issue: ${execFailedSeen}. Tried: ${triedSummary}. ` +
      `Check permissions or reinstall: https://nodejs.org/`
    )
  }
  if (lookupFailedSeen) {
    throw new Error(
      `Node.js was not found in common locations, and PATH/registry lookups failed. ` +
      `First issue: ${lookupFailedSeen}. Tried: ${triedSummary}.`
    )
  }
  throw new Error(
    `Node.js not found. Tried: ${triedSummary}. ` +
    `Please install Node.js: https://nodejs.org/`
  )
}

/**
 * 验证 node.exe 可执行且具备 Claude Code 依赖的资源释放能力。
 * - 版本不兼容：抛错（不可恢复，告知用户升级）
 * - 执行失败（stub/损坏/无权限/架构不匹配）：抛错（让 caller 跳到下一个候选）
 * - 校验通过：返回
 */
async function checkNodeVersion(nodePath: string, signal?: AbortSignal): Promise<void> {
  let ver: string
  try {
    // 直接 execFile 调 node.exe，避免 Windows 下经由 cmd.exe 额外引入超时/策略拦截。
    // 保留 windowsHide：避免 node.exe 启动时弹出 DLL 错误对话框挂死。
    throwIfAborted(signal)
    const { stdout } = await execFileTracked(nodePath, ["-v"], {
      encoding: "utf8",
      timeout: NODE_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      signal
    })
    ver = String(stdout).trim()
  } catch (err) {
    if (isCreateCancelled(err)) throw err
    if (isExecAbort(err)) throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
    if (isExecTimeout(err)) {
      throw new Error(
        `${NODE_TIMEOUT_TAG}Timed out while executing Node.js at ${nodePath}. ` +
          `The executable may still work in an interactive terminal, but launching it from a hidden child process was too slow or blocked.`
      )
    }
    throw new Error(
      `Could not execute Node.js at ${nodePath}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // 解析完整版本号 vMAJOR.MINOR.PATCH
  const verMatch = ver.match(/^v(\d+)\.(\d+)\.(\d+)/)
  if (!verMatch) {
    throw new Error(`Could not parse Node.js version at ${nodePath}: got "${ver}"`)
  }
  const major = Number(verMatch[1])
  const minor = Number(verMatch[2])

  // Claude Code 依赖 Symbol.dispose（Explicit Resource Management），
  // 该能力的可用性不是简单的 ">=18"：
  //   18.18.0+  ✅ (LTS 回补)
  //   19.x      ❌ (奇数非 LTS，2023-04-10 EOL，未回补)
  //   20.4.0+   ✅
  //   21.0.0+   ✅ (继承 20.4.0+ 已有能力)
  //   22.0.0+   ✅
  const hasDispose =
    (major === 18 && minor >= 18) ||
    (major === 20 && minor >= 4) ||
    major >= 21
  if (!hasDispose) {
    // 前缀 NODE_INCOMPATIBLE_TAG 是 tryCandidate 用来识别"版本不兼容"分支的契约，文案改动时务必保留前缀
    throw new Error(
      `${NODE_INCOMPATIBLE_TAG}Node.js ${ver} lacks Symbol.dispose support required by Claude Code. ` +
      `Supported versions: 18.18.0+, 20.4.0+, or any version >= 21. Please upgrade: https://nodejs.org/`
    )
  }
}

interface CreateMsg {
  type: "create"
  id: string
  workDir: string
  cols: number
  rows: number
  claudePath: string
  args: string[]
  electronPath: string
  extraEnv?: Record<string, string> // Claude Code 模型相关环境变量
}

interface WriteMsg {
  type: "write"
  id: string
  data: string
}

interface ResizeMsg {
  type: "resize"
  id: string
  cols: number
  rows: number
}

interface DisposeMsg {
  type: "dispose"
  id: string
}

interface AckMsg {
  type: "ack"
  id: string
  bytes: number
}

interface DisposeAllMsg {
  type: "disposeAll"
}

type HostMessage = CreateMsg | WriteMsg | ResizeMsg | DisposeMsg | AckMsg | DisposeAllMsg

function send(msg: Record<string, unknown>): void {
  process.send?.(msg)
}

function clearDisposeWatchdog(id: string): void {
  const timer = disposeWatchdogs.get(id)
  if (timer) {
    clearTimeout(timer)
    disposeWatchdogs.delete(id)
  }
}

function scheduleDisposeWatchdog(id: string, error: string): void {
  clearDisposeWatchdog(id)
  const timer = setTimeout(() => {
    const pty = activePtys.get(id)
    if (pty) {
      try { pty.kill() } catch { /* ignore */ }
    }
    // 这里不要在未等到真实 onExit 前就把 PTY 从 host 跟踪表里抹掉；
    // 否则一旦 kill 本身失效/卡死，底层 shell/Claude 还活着时就会变成 disposeAll 也兜不到的孤儿进程。
    // watchdog 的职责是尽快把“关闭卡住”上报给主进程，让 renderer 收口到失败态；
    // host 侧状态继续保留，后续若 finally/onExit/diposeAll 到来仍能再尝试杀掉它。
    clearDisposeWatchdog(id)
    send({ type: "error", id, error })
  }, DISPOSE_CONFIRM_TIMEOUT_MS)
  timer.unref()
  disposeWatchdogs.set(id, timer)
}

async function handleCreate(msg: CreateMsg): Promise<void> {
  if (activePtys.has(msg.id) || creatingPtys.has(msg.id)) {
    send({
      type: "error",
      id: msg.id,
      error: `PTY ${msg.id} already exists or is being created`
    })
    return
  }
  creatingPtys.add(msg.id)
  const controller = new AbortController()
  createControllers.set(msg.id, controller)
  try {
    const throwIfCreateCancelled = (): void => {
      if (cancelledCreates.has(msg.id)) {
        cancelledCreates.delete(msg.id)
        controller.abort()
        throw new Error(`${PTY_CREATE_CANCELLED_TAG}${PTY_CREATE_CANCELLED_MESSAGE}`)
      }
    }

    throwIfCreateCancelled()
    const shell = await getShell(controller.signal)
    throwIfCreateCancelled()
    const escapeArg = (arg: string): string => `'${arg.replace(/'/g, "'\\''")}'`

    const isJsFile = msg.claudePath.endsWith(".js")
    const env = { ...process.env, ...(msg.extraEnv || {}) } as Record<string, string>

    // Windows: 把我们找到的 bash.exe 路径告知 Claude Code，避免其内部检测失败
    const isWin = platform() === "win32"
    if (isWin && !env.CLAUDE_CODE_GIT_BASH_PATH && basename(shell).toLowerCase().includes("bash")) {
      env.CLAUDE_CODE_GIT_BASH_PATH = shell
    }

    // 构建启动命令
    let claudeCmd: string
    if (isJsFile) {
      if (isWin) {
        // Windows: 用 node.exe（CONSOLE 子系统）替代 electron.exe（GUI 子系统），
        // electron.exe 在 ConPTY 下 process.stdout.isTTY 为 undefined，Claude Code 会误入 --print 模式。
        // 通过环境变量传递路径，避免 MSYS2 命令行参数编码损坏中文路径。
        throwIfCreateCancelled()
        env._CLAW_NODE = await findNodeExe(controller.signal)
        throwIfCreateCancelled()
        env._CLAW_SCRIPT = msg.claudePath
        // 注意：msg.args 仍走命令行参数，当前只含 ASCII flag（--model 等），无中文风险
        claudeCmd = ['"$_CLAW_NODE"', '"$_CLAW_SCRIPT"', ...msg.args.map(escapeArg)].join(" ")
      } else {
        claudeCmd = [escapeArg(msg.electronPath), escapeArg(msg.claudePath), ...msg.args.map(escapeArg)].join(" ")
        env.ELECTRON_RUN_AS_NODE = "1"
      }
    } else {
      claudeCmd = [escapeArg(msg.claudePath), ...msg.args.map(escapeArg)].join(" ")
    }

    // Claude Code 退出后清除敏感环境变量，再 exec 回交互式 shell
    const varsToUnset: string[] = []
    if (msg.extraEnv) {
      varsToUnset.push(...Object.keys(msg.extraEnv))
    }
    if (isJsFile && !isWin) {
      varsToUnset.push("ELECTRON_RUN_AS_NODE")
    }
    if (isJsFile && isWin) {
      varsToUnset.push("_CLAW_NODE", "_CLAW_SCRIPT")
    }

    const shellCmd = varsToUnset.length > 0
      ? claudeCmd + ` ; ${varsToUnset.map((v) => `unset ${escapeArg(v)}`).join("; ")}; exec ${escapeArg(shell)} -l`
      : claudeCmd + ` ; exec ${escapeArg(shell)} -l`

    throwIfCreateCancelled()

    const pty = ptySpawn(shell, ["-c", shellCmd], {
      name: "xterm-256color",
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.workDir || homedir() || process.cwd(),
      env
    })

    activePtys.set(msg.id, pty)
    pendingBytes.set(msg.id, 0)
    paused.set(msg.id, false)

    pty.onExit(({ exitCode }) => {
      clearDisposeWatchdog(msg.id)
      send({ type: "exit", id: msg.id, exitCode })
      activePtys.delete(msg.id)
      cancelledCreates.delete(msg.id)
      pendingBytes.delete(msg.id)
      paused.delete(msg.id)
    })

    if (cancelledCreates.has(msg.id)) {
      cancelledCreates.delete(msg.id)
      try {
        pty.kill()
        scheduleDisposeWatchdog(msg.id, "PTY creation cancellation timed out")
      } catch (err) {
        console.warn(`[PtyHost] Failed to kill cancelled PTY ${msg.id}:`, err)
        // 这条 PTY 还没挂 onData，继续留在 host 里只会变成黑洞；启动 watchdog 兜底清理，
        // 并让主进程不要再无意义地等满 15s。
        scheduleDisposeWatchdog(msg.id, "PTY creation cancellation failed")
      }
      // PTY 已经 spawn 出来后再收到取消时，不要立刻回 "PTY creation cancelled" 给主进程，
      // 否则 main 会把这次 dispose 过早视为已完成。优先等真实 exit；若迟迟不来，由 watchdog
      // 再回 error 收尾。
      return
    }

    pty.onData((data) => {
      const current = (pendingBytes.get(msg.id) || 0) + Buffer.byteLength(data)
      pendingBytes.set(msg.id, current)
      if (current > HIGH_WATER_MARK && !paused.get(msg.id)) {
        pty.pause()
        paused.set(msg.id, true)
      }
      send({ type: "data", id: msg.id, data })
    })

    send({ type: "created", id: msg.id })
  } catch (err) {
    const msgText = err instanceof Error ? err.message : String(err)
    send({
      type: "error",
      id: msg.id,
      error: msgText.startsWith(PTY_CREATE_CANCELLED_TAG)
        ? msgText.slice(PTY_CREATE_CANCELLED_TAG.length)
        : msgText
    })
  } finally {
    createControllers.delete(msg.id)
    if (!activePtys.has(msg.id)) {
      cancelledCreates.delete(msg.id)
    }
    creatingPtys.delete(msg.id)
  }
}

function handleWrite(msg: WriteMsg): void {
  const pty = activePtys.get(msg.id)
  if (pty) pty.write(msg.data)
}

function handleResize(msg: ResizeMsg): void {
  const pty = activePtys.get(msg.id)
  if (pty) pty.resize(msg.cols, msg.rows)
}

function handleAck(msg: AckMsg): void {
  // PTY 已退出后到达的 ack：直接丢弃，避免重新创建 pendingBytes / paused entry 导致内存涓流
  if (!activePtys.has(msg.id)) return
  const clamped = Math.max(0, (pendingBytes.get(msg.id) || 0) - msg.bytes)
  pendingBytes.set(msg.id, clamped)

  if (clamped < LOW_WATER_MARK && paused.get(msg.id)) {
    const pty = activePtys.get(msg.id)
    if (pty) pty.resume()
    paused.set(msg.id, false)
  }
}

function handleDispose(msg: DisposeMsg): void {
  const hasActivePty = activePtys.has(msg.id)
  const isCreating = creatingPtys.has(msg.id)

  // 只有“创建中的同 id”才需要用 cancelledCreates 让 in-flight handleCreate 早退。
  // 对已创建成功、仅等待 pty.kill()/onExit 收尾的旧 PTY，不要再打 cancelled 标记，
  // 否则同 id 的后续 create 可能会被误判成“上一次创建取消”。
  if (isCreating) {
    cancelledCreates.add(msg.id)
  } else {
    cancelledCreates.delete(msg.id)
  }
  const controller = createControllers.get(msg.id)
  if (controller) controller.abort()
  if (!isCreating && !hasActivePty) {
    createControllers.delete(msg.id)
  }
  const pty = hasActivePty ? activePtys.get(msg.id) : undefined
  if (pty) {
    try {
      pty.kill()
      scheduleDisposeWatchdog(msg.id, PTY_DISPOSE_TIMED_OUT_MESSAGE)
      // 这里只代表“已向 PTY 发出 kill”，不代表它已经真正退出。
      // 必须继续等真实的 onExit 来做最终收尾；否则 main / renderer 会把 Stop/Close
      // 过早视为成功，而尾部 onData/onExit 仍可能迟到到达，造成生命周期判断提前。
      // 因此这里不要提前删 activePtys/pendingBytes/paused，也不要立刻回 disposed。
    } catch {
      // kill 同步抛错时，不能把这条 PTY 从 host 状态里提前抹掉；
      // 否则如果底层进程其实还活着，就会变成后续 disposeAll 也兜不到的孤儿进程。
      // 挂一个 watchdog 兜底：若真实 onExit 一直不来，至少能清掉 host 侧状态并通知主进程收尾。
      console.warn(`[PtyHost] Failed to kill PTY ${msg.id} during dispose; keeping host-side state for timeout/retry recovery`)
      scheduleDisposeWatchdog(msg.id, PTY_DISPOSE_TIMED_OUT_MESSAGE)
      return
    }
    return
  }
  pendingBytes.delete(msg.id)
  paused.delete(msg.id)
  clearDisposeWatchdog(msg.id)
  if (!isCreating) {
    send({ type: "disposed", id: msg.id })
  }
}

function handleDisposeAll(): void {
  killAllExecChildren()
  for (const timer of disposeWatchdogs.values()) {
    clearTimeout(timer)
  }
  disposeWatchdogs.clear()
  for (const [, pty] of activePtys) {
    try { pty.kill() } catch { /* ignore */ }
  }
  activePtys.clear()
  createControllers.clear()
  cancelledCreates.clear()
  creatingPtys.clear()
  pendingBytes.clear()
  paused.clear()
  // #2 fix: 清理完毕后自行退出，避免被强制 kill 导致孤儿进程
  process.exit(0)
}

process.on("message", (msg: HostMessage) => {
  switch (msg.type) {
    case "create": void handleCreate(msg); break
    case "write": handleWrite(msg); break
    case "resize": handleResize(msg); break
    case "ack": handleAck(msg); break
    case "dispose": handleDispose(msg); break
    case "disposeAll": handleDisposeAll(); break
  }
})

// 父进程退出时清理（handleDisposeAll 内部会调 process.exit(0)）
process.on("disconnect", () => {
  handleDisposeAll()
})

// 致命异常前 kill 所有活跃 PTY，避免孤儿子进程残留（OS 通常会清，但显式 kill 更可靠）
function killAllActivePtys(): void {
  for (const [, pty] of activePtys) {
    try { pty.kill() } catch { /* ignore */ }
  }
}

function killAllExecChildren(): void {
  for (const [, controller] of createControllers) {
    controller.abort()
  }
  for (const child of activeExecChildren) {
    try { child.kill() } catch { /* ignore */ }
  }
  activeExecChildren.clear()
}

// 全局异常捕获：通知父进程后主动退出，让父进程的 child.on("exit") 走 tearDownCurrentHost。
// 不退出会让 host 卡在半死状态：handler 装着，但 PTY map 已经被异常路径污染。
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught exception:", err)
  try { send({ type: "error", error: err.message }) } catch { /* IPC 已断 */ }
  killAllActivePtys()
  killAllExecChildren()
  // 给 IPC 发送一个 microtask 的窗口再退出
  setImmediate(() => process.exit(1))
})

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error("[PtyHost] Unhandled rejection:", reason)
  try { send({ type: "error", error: msg }) } catch { /* IPC 已断 */ }
  killAllActivePtys()
  killAllExecChildren()
  setImmediate(() => process.exit(1))
})

send({ type: "ready" })
