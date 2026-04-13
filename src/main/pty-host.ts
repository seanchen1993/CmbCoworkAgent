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
import { execSync } from "child_process"

const activePtys = new Map<string, IPty>()

// 流控：高低水位线，防止缓冲区溢出
const HIGH_WATER_MARK = 5 * 1024 * 1024  // 5MB 暂停
const LOW_WATER_MARK = 1 * 1024 * 1024   // 1MB 恢复
const pendingBytes = new Map<string, number>()
const paused = new Map<string, boolean>()

// checkNodeVersion 与 tryCandidate 共享的"版本不兼容"标识：
// 用 sentinel 前缀而非 err.message.includes(...) 字符串匹配，避免改文案时漏改导致分类静默走错路径
const NODE_INCOMPATIBLE_TAG = "[NODE_INCOMPATIBLE] "

// 剥离 BOM 并 trim
function stripBomTrim(s: string): string {
  return s.replace(/^\uFEFF/, "").trim()
}

// 展开 REG_EXPAND_SZ 中的 %ENV% 引用
function expandEnvVars(s: string): string {
  return s.replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`)
}

let cachedShell: string | null = null
function getShell(): string {
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
      triedPaths.push(p)
      if (existsSync(p)) {
        cachedShell = p
        return cachedShell
      }
    }

    // 2. where git 推导 bash 路径（git.exe 在 PATH 中的概率比 bash.exe 高）
    // 多个 git.exe 共存时（portable shim + 完整安装等），逐个尝试推导，直到找到带 bash.exe 的那个
    try {
      const gitOut = execSync("where.exe git", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
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
    } catch {
      triedPaths.push("where:failed")
    }

    // 3. 注册表兜底（覆盖任意安装路径，git 不在 PATH 时仍可定位）
    const regKeys = [
      "HKLM\\SOFTWARE\\GitForWindows",
      "HKCU\\SOFTWARE\\GitForWindows"
    ]
    for (const key of regKeys) {
      try {
        const regOut = execSync(
          `reg query "${key}" /v InstallPath`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }
        )
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
      } catch { /* key not found */ }
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
function findNodeExe(): string {
  if (platform() !== "win32") throw new Error("findNodeExe is Windows-only")
  if (cachedNodeExe) return cachedNodeExe

  const triedPaths: string[] = []

  // 1. 快速检查常见路径（便宜：只是 stat 调用）
  const candidates = [
    join("C:\\", "Program Files", "nodejs", "node.exe"),
    join("C:\\", "Program Files (x86)", "nodejs", "node.exe"),
    join("D:\\", "Program Files", "nodejs", "node.exe"),
    join("D:\\", "Program Files (x86)", "nodejs", "node.exe"),
    join(homedir(), "scoop", "apps", "nodejs", "current", "node.exe"),
    join(homedir(), ".volta", "bin", "node.exe"),
  ]
  // nvm-windows 的活跃版本 symlink 通常在 NVM_SYMLINK（默认 C:\Program Files\nodejs，已被上面覆盖）
  const nvmSymlink = process.env.NVM_SYMLINK
  if (nvmSymlink) candidates.push(join(nvmSymlink, "node.exe"))

  // 探测一个已存在的候选路径：校验通过则缓存返回 "ok"，否则返回失败原因。
  // 不在版本不兼容时立即抛出 —— 用户可能同时装了不兼容旧版和兼容新版，旧的不能否决整个搜索。
  // triedPaths 由外层统一记录，避免双 push 导致最终错误冗长。
  let incompatibleSeen: string | null = null
  let execFailedSeen: string | null = null
  type TryResult = "ok" | "incompatible" | "exec-failed"
  const tryCandidate = (p: string, label: string): TryResult => {
    try {
      checkNodeVersion(p)
      cachedNodeExe = p
      return "ok"
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith(NODE_INCOMPATIBLE_TAG)) {
        // 用户向错误展示时去掉内部 sentinel 前缀
        const cleanMsg = msg.slice(NODE_INCOMPATIBLE_TAG.length)
        if (!incompatibleSeen) incompatibleSeen = `${label} (${p}): ${cleanMsg}`
        console.warn(`[PtyHost] Skipping ${label} (${p}): incompatible Node.js version, continuing search`)
        return "incompatible"
      }
      if (!execFailedSeen) execFailedSeen = `${label} (${p}): ${msg}`
      console.warn(`[PtyHost] Skipping ${label} (${p}): ${msg}`)
      return "exec-failed"
    }
  }

  // 单条 triedPaths 的状态后缀，避免外层为同一个候选 push 两次
  const trySuffix = (r: TryResult): string =>
    r === "incompatible" ? ":incompatible" : r === "exec-failed" ? ":exec-failed" : ""

  for (const p of candidates) {
    if (!existsSync(p)) {
      triedPaths.push(`${p}:not-exists`)
      continue
    }
    const r = tryCandidate(p, "candidate")
    if (r === "ok") return cachedNodeExe!
    triedPaths.push(`${p}${trySuffix(r)}`)
  }

  // 2. where.exe 查找（PATH 中，可能有多个 node.exe：nvm / Scoop / MSI 共存）
  try {
    const out = execSync("where.exe node.exe", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
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
      const r = tryCandidate(line, "where")
      if (r === "ok") return cachedNodeExe!
      triedPaths.push(`where:${line}${trySuffix(r)}`)
    }
  } catch {
    triedPaths.push("where:failed")
  }

  // 3. 注册表兜底（Node.js MSI 安装会写 HKLM/HKCU SOFTWARE\Node.js InstallPath）
  const regKeys = [
    "HKLM\\SOFTWARE\\Node.js",
    "HKCU\\SOFTWARE\\Node.js",
    "HKLM\\SOFTWARE\\WOW6432Node\\Node.js"
  ]
  for (const key of regKeys) {
    try {
      const regOut = execSync(
        `reg query "${key}" /v InstallPath`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }
      )
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
        const r = tryCandidate(regNode, `reg:${key}`)
        if (r === "ok") return cachedNodeExe!
        triedPaths.push(`reg:${key}:${regNode}${trySuffix(r)}`)
      }
    } catch { /* key not found */ }
  }

  // 全部候选都失败：如果至少有一个候选是版本不兼容，优先报告"升级"，否则报告"找不到"
  // 错误消息只包含摘要（前 3 条 + 总数），完整列表打到日志，避免几 KB 的字符串塞进 IPC/弹窗
  const triedSummary = triedPaths.length <= 3
    ? triedPaths.join("; ")
    : `${triedPaths.slice(0, 3).join("; ")}; ... (+${triedPaths.length - 3} more)`
  console.error(`[PtyHost] findNodeExe failed. All tried paths:\n${triedPaths.join("\n")}`)

  if (incompatibleSeen && execFailedSeen) {
    // 混合失败：有版本不兼容的，也有存在但无法执行的，两类排查方向都给出
    throw new Error(
      `Node.js found but not fully usable. Some versions are incompatible with Claude Code: ${incompatibleSeen}. ` +
      `Some failed to execute: ${execFailedSeen}. Tried: ${triedSummary}. ` +
      `Upgrade Node.js and check permissions: https://nodejs.org/`
    )
  }
  if (incompatibleSeen) {
    throw new Error(
      `All discovered Node.js installations are incompatible with Claude Code. ` +
      `First match: ${incompatibleSeen}. Tried: ${triedSummary}. ` +
      `Please upgrade: https://nodejs.org/`
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
function checkNodeVersion(nodePath: string): void {
  let ver: string
  try {
    // stdio + windowsHide：避免 node.exe 启动时弹出 Windows DLL 错误对话框挂死，
    // 也避免 stderr 警告污染父进程日志
    ver = execSync(`"${nodePath}" -v`, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim()
  } catch (err) {
    throw new Error(`Could not execute Node.js at ${nodePath}: ${err instanceof Error ? err.message : String(err)}`)
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

function handleCreate(msg: CreateMsg): void {
  try {
    const shell = getShell()
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
        env._CLAW_NODE = findNodeExe()
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

    pty.onData((data) => {
      const current = (pendingBytes.get(msg.id) || 0) + Buffer.byteLength(data)
      pendingBytes.set(msg.id, current)
      if (current > HIGH_WATER_MARK && !paused.get(msg.id)) {
        pty.pause()
        paused.set(msg.id, true)
      }
      send({ type: "data", id: msg.id, data })
    })

    pty.onExit(({ exitCode }) => {
      send({ type: "exit", id: msg.id, exitCode })
      activePtys.delete(msg.id)
      pendingBytes.delete(msg.id)
      paused.delete(msg.id)
    })

    send({ type: "created", id: msg.id })
  } catch (err) {
    send({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
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
  const pty = activePtys.get(msg.id)
  if (pty) {
    pty.kill()
    activePtys.delete(msg.id)
  }
  pendingBytes.delete(msg.id)
  paused.delete(msg.id)
}

function handleDisposeAll(): void {
  for (const [, pty] of activePtys) {
    pty.kill()
  }
  activePtys.clear()
  pendingBytes.clear()
  paused.clear()
  // #2 fix: 清理完毕后自行退出，避免被强制 kill 导致孤儿进程
  process.exit(0)
}

process.on("message", (msg: HostMessage) => {
  switch (msg.type) {
    case "create": handleCreate(msg); break
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

// 全局异常捕获：通知父进程后主动退出，让父进程的 child.on("exit") 走 tearDownCurrentHost。
// 不退出会让 host 卡在半死状态：handler 装着，但 PTY map 已经被异常路径污染。
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught exception:", err)
  try { send({ type: "error", error: err.message }) } catch { /* IPC 已断 */ }
  killAllActivePtys()
  // 给 IPC 发送一个 microtask 的窗口再退出
  setImmediate(() => process.exit(1))
})

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error("[PtyHost] Unhandled rejection:", reason)
  try { send({ type: "error", error: msg }) } catch { /* IPC 已断 */ }
  killAllActivePtys()
  setImmediate(() => process.exit(1))
})

send({ type: "ready" })
