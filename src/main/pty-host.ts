/**
 * Pty Host — 独立子进程，管理所有 node-pty 实例。
 * 避免 PTY I/O 阻塞主进程事件循环。
 * 通过 process.send / process.on("message") 与主进程通信。
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

let cachedShell: string | null = null
function getShell(): string {
  if (cachedShell) return cachedShell
  if (platform() === "win32") {
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
      if (existsSync(p)) {
        cachedShell = p
        return cachedShell
      }
    }

    // 2. where git 推导 bash 路径（git.exe 在 PATH 中的概率比 bash.exe 高）
    try {
      const gitOut = execSync("where.exe git", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      })
      const gitExe = gitOut.trim().split(/\r?\n/).find(
        (l) => !l.toLowerCase().includes("system32")
      )
      if (gitExe) {
        const derivedBash = join(gitExe, "..", "..", "bin", "bash.exe")
        if (existsSync(derivedBash)) {
          cachedShell = derivedBash
          return cachedShell
        }
      }
    } catch {}

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
        const match = /InstallPath\s+REG_SZ\s+(.+)/i.exec(regOut)
        if (match) {
          const installDir = match[1].trim()
          const regBash = join(installDir, "bin", "bash.exe")
          if (existsSync(regBash)) {
            cachedShell = regBash
            return cachedShell
          }
          console.warn(`[PtyHost] Registry found Git at ${installDir} but bash.exe not found`)
        }
      } catch { /* key not found */ }
    }
    throw new Error(
      "Git Bash not found. Please install Git for Windows: https://git-scm.com/download/win"
    )
  } else {
    cachedShell = process.env.SHELL || "/bin/zsh"
  }
  return cachedShell
}

let cachedNodeExe: string | null = null
function findNodeExe(): string {
  if (cachedNodeExe) return cachedNodeExe
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

  for (const p of candidates) {
    if (existsSync(p)) {
      checkNodeVersion(p)
      cachedNodeExe = p
      return cachedNodeExe
    }
  }
  // 兜底：where.exe 查找
  try {
    const out = execSync("where node.exe", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    })
    const found = out.trim().split(/\r?\n/)[0]
    if (found) {
      checkNodeVersion(found)
      cachedNodeExe = found
      return cachedNodeExe
    }
  } catch {}
  throw new Error("Node.js not found. Please install Node.js: https://nodejs.org/")
}

function checkNodeVersion(nodePath: string): void {
  try {
    const ver = execSync(`"${nodePath}" -v`, { encoding: "utf8", timeout: 3000 }).trim()
    const major = parseInt(ver.slice(1), 10)
    if (major < 18) {
      throw new Error(`Node.js ${ver} is too old, need >= 18. Please upgrade: https://nodejs.org/`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("too old")) throw err
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

// 全局异常捕获，防止子进程静默崩溃
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught exception:", err)
  send({ type: "error", error: err.message })
})

process.on("unhandledRejection", (reason) => {
  console.error("[PtyHost] Unhandled rejection:", reason)
})

send({ type: "ready" })
