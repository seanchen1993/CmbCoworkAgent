/**
 * Terminal IPC handlers — 主进程端。
 * PTY 操作全部代理到独立的 Pty Host 子进程，
 * 避免 PTY I/O 阻塞主进程事件循环。
 */
import { IpcMain, BrowserWindow, dialog } from "electron"
import { fork, type ChildProcess } from "node:child_process"
import { accessSync } from "fs"
import path from "path"
import { app } from "electron"
import { getCustomModelConfigById, syncSkillsToClaudeDir } from "../storage"
import { homedir } from "os"

// TODO: 当 CmbCowork 记忆系统改为按项目隔离后，使用与 Claude Code 相同的算法按项目拼接路径：
// 1. findCanonicalGitRoot(effectiveWorkDir) 获取 git 仓库根目录（worktree 解析到主仓库）
// 2. sanitizePath() 将路径中非字母数字字符替换为 -
// 3. 最终路径：~/.cmbcoworkagent/memory/{sanitizedPath}/
// 参考 claude-code/src/memdir/paths.ts 的 getAutoMemPath() 实现。
const MEMORY_DIR = path.join(homedir(), ".cmbcoworkagent", "memory")

// 从 .env 读取代理地址，和项目其他地方一致用 import.meta.env
function getClaudeCodeProxyBase(): string {
  return (import.meta.env.VITE_CLAUDE_CODE_PROXY_BASE as string) || ""
}

function buildClaudeEnv(modelId: string, syncMemory: boolean): Record<string, string> {
  const config = getCustomModelConfigById(modelId)
  if (!config) throw new Error(`模型配置不存在: ${modelId}`)
  const proxyBase = getClaudeCodeProxyBase()
  if (!proxyBase) throw new Error("VITE_CLAUDE_CODE_PROXY_BASE 未配置")
  if (!config.apiKey) throw new Error(`模型 "${config.name}" 的 API Key 未设置`)
  const baseUrl = `${proxyBase.replace(/\/+$/, '')}/${config.model}`
  const env: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: config.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
    CLAUDE_CODE_SUBAGENT_MODEL: config.model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.maxTokens || 128000),
    CLAUDE_CODE_IS_COWORK: "1"
  }
  if (syncMemory) {
    env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = MEMORY_DIR
  }
  return env
}

let ptyHost: ChildProcess | null = null
let idCounter = 0
let isShuttingDown = false

// 每个 PTY 对应的 BrowserWindow，用于将数据转发到正确的渲染进程
const ptyWindows = new Map<string, BrowserWindow>()

// #7 fix: 统一的窗口关闭监听器，避免 window.once 只触发一次的问题
const windowCleanupRegistered = new WeakSet<BrowserWindow>()

// P1 fix: 等待子进程确认创建成功/失败
const pendingCreates = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()

function getClaudePath(): string {
  const isWin = process.platform === "win32"
  const binName = isWin ? "claude.cmd" : "claude"

  // 方式1: 直接用 @anthropic-ai/claude-code 的 cli.js（最可靠，不依赖 .bin shim）
  const cliJs = path.join(app.getAppPath(), "node_modules", "@anthropic-ai", "claude-code", "cli.js")
  const unpackedCliJs = cliJs.replace("app.asar", "app.asar.unpacked")
  try { accessSync(unpackedCliJs); return unpackedCliJs } catch { /* continue */ }
  try { accessSync(cliJs); return cliJs } catch { /* continue */ }

  // 方式2: .bin shim
  const localBin = path.join(app.getAppPath(), "node_modules", ".bin", binName)
  const unpackedBin = localBin.replace("app.asar", "app.asar.unpacked")
  try { accessSync(unpackedBin); return unpackedBin } catch { /* continue */ }
  try { accessSync(localBin); return localBin } catch { /* continue */ }

  console.warn("[Terminal] Claude Code not found in node_modules, falling back to PATH lookup")
  return binName
}

function getPtyHostPath(): string {
  // #1 fix: fork() 不能从 asar 内加载，需要用 unpacked 路径
  const outPath = path.join(app.getAppPath(), "out", "main", "pty-host.js")
  const unpackedPath = outPath.replace("app.asar", "app.asar.unpacked")
  try {
    accessSync(unpackedPath)
    return unpackedPath
  } catch {
    try {
      accessSync(outPath)
      return outPath
    } catch {
      return path.join(__dirname, "pty-host.js")
    }
  }
}

let ptyHostReadyPromise: Promise<void> | null = null
let ptyHostReadyTimer: NodeJS.Timeout | null = null

function ensurePtyHost(): ChildProcess {
  if (isShuttingDown) throw new Error("Application is shutting down")
  if (ptyHost && !ptyHost.killed && ptyHost.connected) return ptyHost

  const hostPath = getPtyHostPath()
  console.log(`[Terminal] Spawning Pty Host: ${hostPath}`)

  let resolveReady: () => void
  let rejectReady: (err: Error) => void
  let hostReady = false
  ptyHostReadyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // 这条 .catch 是必要的兜底：tearDownCurrentHost 会在 child error/exit 时调 rejectReady!()，
  // 如果此时还没有任何 caller await 到 ptyHostReadyPromise 上（比如 host spawn 立刻失败、
  // 或 disposeAllTerminals 在 in-flight create 之前就走完），rejection 会作为 unhandled rejection
  // 浮上来。挂一个空 .catch 让 rejection 立即被消费；真正的 await 方仍然能拿到 reject（同一个 promise）。
  ptyHostReadyPromise.catch(() => { /* no-op */ })

  const child = fork(hostPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env }
  })
  ptyHost = child

  // 代际守卫：handlers 用闭包捕获 child，回调触发时检查 ptyHost 是否还是自己这代，
  // 否则跳过全局状态修改，避免 ready timeout kill 旧 host 后旧 exit 事件误清新 host 状态
  const isCurrent = (): boolean => ptyHost === child

  // 统一在 ensurePtyHost 里管理 ready 超时，避免每个 terminal:create 各自建 timer 导致堆积
  if (ptyHostReadyTimer) clearTimeout(ptyHostReadyTimer)
  ptyHostReadyTimer = setTimeout(() => {
    // 先 settle 自己这代的 ready promise，避免 await 方在 shutdown 等场景下永久悬挂；
    // rejectReady 是闭包绑定到本代 promise，对已 settle 的 promise 是 no-op，跨代安全
    if (!hostReady) {
      rejectReady!(new Error("Pty Host ready timed out"))
    }
    if (!isCurrent()) return
    ptyHostReadyTimer = null
    ptyHostReadyPromise = null
    // host 卡在初始化阶段：主动 kill 并置 null，下次 ensurePtyHost 一定重建
    // 20s：send({type:"ready"}) 在 pty-host.ts 文件最末尾，前面要完成所有 import
    // （含 node-pty 原生模块加载），Windows 杀软冷扫 .node 文件容易超 10s，20s 留足余量
    console.warn("[Terminal] Pty Host ready timed out, killing stuck host")
    try { child.kill() } catch { /* ignore */ }
    ptyHost = null
  }, 20_000).unref()

  child.on("message", (msg: { type: string; id?: string; data?: string; exitCode?: number; error?: string }) => {
    if (msg.type === "ready") {
      if (!isCurrent()) return
      console.log("[Terminal] Pty Host ready")
      if (ptyHostReadyTimer) { clearTimeout(ptyHostReadyTimer); ptyHostReadyTimer = null }
      hostReady = true
      resolveReady!()
      return
    }

    // created/error/data/exit 不需要 isCurrent 守卫：会被代际守卫排除的旧 host 只可能是
    // 卡在 ready 之前被 kill 掉的 stuck host，那样的 host 从未收到过 create 消息（create 在
    // await ready 之后才发），所以不可能产生 id 类回信。即便万一发生，按 id 单条操作也无副作用。
    if (msg.type === "created" && msg.id) {
      const pending = pendingCreates.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve()
        pendingCreates.delete(msg.id)
      }
      return
    }

    if (msg.type === "error") {
      if (msg.id) {
        const pending = pendingCreates.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error(msg.error || "PTY creation failed"))
          pendingCreates.delete(msg.id)
        }
      } else {
        // 全局异常，无 id，记日志
        console.error("[Terminal] Pty Host error:", msg.error)
      }
      return
    }

    if (msg.type === "data" && msg.id) {
      const win = ptyWindows.get(msg.id)
      if (win && !win.isDestroyed()) {
        // 数据和字节数一起发给渲染端，渲染端消费后发 ack 回来
        win.webContents.send(`terminal:data:${msg.id}`, msg.data, Buffer.byteLength((msg.data as string) || ""))
      }
      return
    }

    if (msg.type === "exit" && msg.id) {
      const win = ptyWindows.get(msg.id)
      if (win && !win.isDestroyed()) {
        win.webContents.send(`terminal:exit:${msg.id}`, msg.exitCode)
      }
      ptyWindows.delete(msg.id)
      return
    }
  })

  // exit / error 共用的 tear-down：通知所有 ptyWindows、reject 等待方、清空全局状态。
  // exitCodeOrError 用于构造抛给 caller 的 reason 和发给 renderer 的退出码。
  const tearDownCurrentHost = (exitCodeOrError: number | Error | null): void => {
    const reason = exitCodeOrError instanceof Error
      ? exitCodeOrError
      : new Error(`Pty Host exited with code ${exitCodeOrError ?? "null (killed by signal)"}`)
    const exitCodeForRenderer = exitCodeOrError instanceof Error ? null : exitCodeOrError

    // 1. settle 本代 ready promise（任何代际都做，避免 shutdown/spawn-fail 时 await 永久悬挂）
    if (!hostReady) {
      rejectReady!(reason)
    }
    // 2. 旧代 host 不动全局状态，避免误清新 host
    // 命中场景：ready timeout 主动 kill stuck host、被新一代 host 替换、或 spawn fail 已先走 error handler
    if (!isCurrent()) {
      console.log("[Terminal] Stale Pty Host exited (killed by ready timeout / replaced / already torn down), skipping global cleanup")
      return
    }
    // 3. 通知所有渲染端：你的终端已经死了
    for (const [id, win] of ptyWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send(`terminal:exit:${id}`, exitCodeForRenderer)
      }
    }
    // 4. 清空全局状态
    ptyHost = null
    if (ptyHostReadyTimer) { clearTimeout(ptyHostReadyTimer); ptyHostReadyTimer = null }
    ptyHostReadyPromise = null
    ptyWindows.clear()
    // 5. reject 所有等待中的 create 请求（含 shutdown 期间正在跑的 terminal:create）
    for (const [, pending] of pendingCreates) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    pendingCreates.clear()
  }

  child.on("exit", (code) => {
    console.log(`[Terminal] Pty Host exited with code ${code}`)
    tearDownCurrentHost(code)
    if (!isShuttingDown && code !== 0) {
      console.log("[Terminal] Pty Host crashed, will restart on next terminal:create")
    }
  })

  child.stdout?.on("data", (data: Buffer) => {
    console.log(`[PtyHost stdout] ${data.toString().trim()}`)
  })
  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[PtyHost stderr] ${data.toString().trim()}`)
  })

  // 'error' 事件来源：
  // - fork 失败 (ENOENT/ENOMEM)：Node 只保证 'error'，不一定再触发 'exit'
  // - host ready 之后 IPC send 失败 / 通道断开
  // 两种情况都意味着我们再也无法和这个 host 通信，必须走完整 tear-down，
  // 否则 caller 会等到 10s ready timeout（spawn fail 场景），或 renderer 停在"假在线"状态（IPC 故障场景）。
  child.on("error", (err) => {
    console.error("[Terminal] Pty Host process error:", err)
    tearDownCurrentHost(err)
  })

  return child
}

/**
 * 向 Pty Host 发消息。
 * 重要：不会调用 ensurePtyHost。host 已死/未启动时：
 * - 默认（write/resize/dispose 等清理路径）：静默返回，避免意外复活 host 产生幽灵子进程，
 *   也避免触发无人 await 的 ready promise 导致 UnhandledPromiseRejection
 * - throwOnError=true（terminal:create）：抛错让 caller 立即失败，不被 60s create timeout 故障放大
 * Host 启动只在 terminal:create 路径里显式触发。
 */
function sendToHost(msg: Record<string, unknown>, throwOnError = false): void {
  if (isShuttingDown) {
    if (throwOnError) throw new Error("Application is shutting down")
    return
  }
  if (!ptyHost || ptyHost.killed || !ptyHost.connected) {
    if (throwOnError) throw new Error("Pty Host is not running")
    return
  }
  try {
    ptyHost.send(msg)
  } catch (err) {
    if (throwOnError) {
      console.error("[Terminal] sendToHost failed:", err)
      throw err
    }
    console.warn("[Terminal] sendToHost failed:", err)
  }
}

// 安全检查：只允许本地页面或配置的远程 renderer 调用终端 API
function isAllowedSender(sender: Electron.WebContents): boolean {
  const url = sender.getURL()
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "localhost" || parsed.protocol === "file:") return true
    // 支持配置的远程 renderer，按 origin 精确匹配
    const renderUrl = process.env.ELECTRON_RENDERER_URL
    if (renderUrl) {
      const allowed = new URL(renderUrl)
      if (parsed.origin === allowed.origin) return true
    }
  } catch { return false }
  return false
}

// #7 fix: 为 BrowserWindow 注册统一的关闭监听器
function ensureWindowCleanup(win: BrowserWindow): void {
  if (windowCleanupRegistered.has(win)) return
  windowCleanupRegistered.add(win)

  win.on("closed", () => {
    // 遍历所有属于该窗口的 PTY，全部清理
    for (const [id, w] of ptyWindows) {
      if (w === win) {
        // sendToHost 默认 throwOnError=false，host 不在/send 失败时只 warn 不抛，无需 try/catch
        sendToHost({ type: "dispose", id })
        ptyWindows.delete(id)
      }
    }
  })
}

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  console.log("[Terminal] Registering terminal handlers...")

  ipcMain.handle(
    "terminal:create",
    async (event, { workDir, args, cols: initCols, rows: initRows, claudeModelId, syncSkills = false, syncMemory = false }: { workDir?: string; args?: string[]; cols?: number; rows?: number; claudeModelId?: string; syncSkills?: boolean; syncMemory?: boolean }) => {
      const id = `term-${++idCounter}`
      const window = BrowserWindow.fromWebContents(event.sender)
      // ptyCreated 在 try/catch 两侧共享：createPromise resolve 后标记为 true。
      // catch 块用它判断 PTY 是否已在子进程里存在，若存在则无条件发 dispose，
      // 防止窗口关闭竞态（closed 回调的早发 dispose 因 PTY 尚未创建而 no-op）导致孤儿 PTY。
      let ptyCreated = false
      try {
        if (!window) throw new Error("No window found")
        if (!isAllowedSender(event.sender)) {
          throw new Error("Terminal creation not allowed from remote pages")
        }

        ptyWindows.set(id, window)
        ensureWindowCleanup(window)

        // 防止孤儿 PTY：等 host ready 这段时间窗口可能被关闭，window.closed 回调里会
        // ptyWindows.delete(id) 并发 dispose 消息，但 PTY 还没在子进程里创建，dispose 是 no-op；
        // 然后 ready 完成、create 消息真的发出去，子进程会创建一个永远没人 dispose 的 PTY。
        // 在每个 await 之后重新检查窗口和 ptyWindows entry，没人认领就放弃。
        const ensureStillAlive = (stage: string): void => {
          if (window.isDestroyed() || event.sender.isDestroyed()) {
            throw new Error(`Window destroyed before PTY creation finished (${stage})`)
          }
          if (ptyWindows.get(id) !== window) {
            throw new Error(`PTY ${id} no longer claimed by window (${stage})`)
          }
        }

        const claudePath = getClaudePath()

        // Ensure Pty Host is ready before sending create message
        // ready 超时 timer 统一在 ensurePtyHost 里管理，此处直接 await 即可。
        // ensurePtyHost 同步返回后 ptyHostReadyPromise 一定不是 null（已 ready 的会保留 settled promise，
        // 新建的会赋上新 promise），所以无需 if 守卫。
        ensurePtyHost()
        await ptyHostReadyPromise!
        ensureStillAlive("after ready")

        const effectiveWorkDir = workDir || process.env.HOME || process.cwd()

        // Sync CmbCowork skills to .claude/skills/ for Claude Code discovery
        if (syncSkills) {
          try {
            await syncSkillsToClaudeDir(effectiveWorkDir)
          } catch (e) {
            console.warn("[Terminal] Failed to sync skills to Claude dir:", e)
          }
          ensureStillAlive("after skill sync")
        }

        const finalArgs = args || []

        // P1 fix: 等待子进程确认创建成功
        const createPromise = new Promise<void>((resolve, reject) => {
          // 超时 30 秒：覆盖 Windows 冷启动 fork pty-host + getShell/findNodeExe 全量查找的最坏情况
          // （Linux/macOS 通常 < 1s）。30s 是体感与最坏路径的折中：足够覆盖杀软扫描，又不会让用户假死太久。
          const timer = setTimeout(() => {
            if (pendingCreates.has(id)) {
              pendingCreates.delete(id)
              reject(new Error("PTY creation timed out"))
              // host 卡在 handleCreate 同步路径（execSync/ptySpawn 挂死）时，IPC 消息队列无法处理，
              // dispose 消息石沉大海，且 connected 仍为 true，ensurePtyHost 会继续复用这个僵尸 host。
              // 30s 已是极限，此时主动 kill：exit 事件会触发 tearDownCurrentHost 完整清理，
              // 包括 reject 其余 pendingCreates（其他 PTY I/O 此时也已冻结，kill 是正确策略）。
              if (ptyHost && !ptyHost.killed) {
                console.warn("[Terminal] PTY creation timed out, killing stuck host")
                try { ptyHost.kill() } catch { /* ignore */ }
              }
            }
          }, 30_000).unref()
          pendingCreates.set(id, { resolve, reject, timer })
        })

        // throwOnError=true：IPC 失败时立刻抛出，避免被 30s create timeout 故障放大
        sendToHost({
          type: "create",
          id,
          workDir: effectiveWorkDir,
          cols: initCols || 120,
          rows: initRows || 30,
          claudePath,
          args: finalArgs,
          electronPath: process.execPath,
          extraEnv: claudeModelId
            ? buildClaudeEnv(claudeModelId, syncMemory)
            : { CLAUDE_CODE_IS_COWORK: "1", ...(syncMemory ? { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: MEMORY_DIR } : {}) }
        }, true)

        await createPromise
        ptyCreated = true
        ensureStillAlive("after created")
        console.log(`[Terminal] Created PTY ${id} via Pty Host, running: ${claudePath}`)
        return id
      } catch (err) {
        // 创建失败：幂等清理主进程状态，通知子进程销毁可能已创建的 PTY。
        // 注意：若 sendToHost(create, true) 同步抛出，timer 尚未被 created/error/exit 清理过，
        // 这里必须 clearTimeout 避免 timer 后续再跑一次。
        // 同样，"after created" 阶段窗口已关的清理也走这里：dispose 消息会通知子进程销毁刚建好的 PTY。
        console.error("[Terminal] Failed to create terminal:", err)
        const pending = pendingCreates.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingCreates.delete(id)
        }
        // 清理 ptyWindows：只有 entry 仍属于本次 create 的 window 时才删除，避免误清他人条目
        const stillOwned = ptyWindows.get(id) === window
        if (stillOwned) ptyWindows.delete(id)
        // 向子进程发 dispose：
        // - 正常失败路径（stillOwned=true）：PTY 可能未创建，dispose 是 no-op 也无害
        // - 窗口关闭竞态（stillOwned=false + ptyCreated=true）：closed 回调在 PTY 尚不存在时
        //   发的早期 dispose 是 no-op，现在 PTY 已确认在子进程里存在，必须补发一次防止孤儿
        if (stillOwned || ptyCreated) {
          // sendToHost 默认 throwOnError=false，host 不在/send 失败时只 warn 不抛，无需 try/catch
          sendToHost({ type: "dispose", id })
        }
        throw err
      }
    }
  )

  ipcMain.on("terminal:write", (event, { id, data }: { id: string; data: string }) => {
    const win = ptyWindows.get(id)
    if (!win || win.webContents.id !== event.sender.id) return
    sendToHost({ type: "write", id, data })
  })

  // P1 fix: 渲染端消费数据后发 ack，主进程转发给 Pty Host
  ipcMain.on("terminal:ack", (event, { id, bytes }: { id: string; bytes: number }) => {
    const win = ptyWindows.get(id)
    if (!win || win.webContents.id !== event.sender.id) return
    sendToHost({ type: "ack", id, bytes })
  })

  ipcMain.on("terminal:resize", (event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const win = ptyWindows.get(id)
    if (!win || win.webContents.id !== event.sender.id) return
    sendToHost({ type: "resize", id, cols, rows })
  })

  ipcMain.handle("terminal:selectDir", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("No window found")
    if (!isAllowedSender(event.sender)) {
      throw new Error("Directory selection not allowed from remote pages")
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle("terminal:dispose", async (event, id: string) => {
    const win = ptyWindows.get(id)
    if (!win || win.webContents.id !== event.sender.id) return
    sendToHost({ type: "dispose", id })
    ptyWindows.delete(id)
    console.log(`[Terminal] Disposed PTY ${id}`)
  })
}

export function disposeAllTerminals(): void {
  // 重入守卫：will-quit 目前只调一次，但加这道防御几乎零成本
  if (isShuttingDown) return
  isShuttingDown = true
  if (ptyHost && !ptyHost.killed) {
    const host = ptyHost
    // race window：host 同步 crash 但 'exit' 还在 macrotask 队列时，killed 仍是 false，
    // host.send 会在已断开的 channel 上抛 ERR_IPC_CHANNEL_CLOSED。如果不吞，会打断
    // will-quit 后续的 LocalSandbox.killAll / stopScheduler / closeRuntime / flush() 链路。
    // 注意：这里不能复用 sendToHost，因为它在 isShuttingDown=true 时会直接 return。
    if (host.connected) {
      try {
        host.send({ type: "disposeAll" })
      } catch (err) {
        console.warn("[Terminal] disposeAll send failed (host already gone):", err)
      }
    } else {
      console.warn("[Terminal] disposeAll skipped: host IPC channel already disconnected")
    }
    // 给子进程 500ms 处理 disposeAll，超时后强制杀。
    // 注意：will-quit 之后这个 500ms timer 不保证能跑满 —— Electron 不承诺退出前留事件循环时间。
    // 即便 timer 没 fire，pty-host.ts 的 process.on("disconnect") 也会兜底调 handleDisposeAll
    // → process.exit(0)，所以两层保护互为后备：
    // 1. 这里的 500ms kill：host 卡在 disposeAll 处理时强制结束
    // 2. pty-host disconnect handler：父进程 IPC 一旦断开，子进程自己退出
    // 改 pty-host 时不要删掉 disconnect handler，否则会出孤儿子进程。
    setTimeout(() => {
      if (!host.killed) host.kill()
    }, 500).unref()
    // 注意：不在这里把 ptyHost 置 null，等 child.on("exit") 自然触发 tearDownCurrentHost，
    // 让 isCurrent() 通过、走完整清理（含 reject in-flight pendingCreates）。
    // 防止 ensurePtyHost 复活的兜底由 isShuttingDown 守卫负责。
  }
  console.log("[Terminal] Requested Pty Host shutdown")
}
