import type { MessageBoxOptions } from "electron"

interface RecoveryContext {
  isAvailable: () => boolean
  show: (options: MessageBoxOptions) => Promise<{ response: number }>
  reload: () => void
  restart: () => void
  quit: () => void
  reportError: (error: unknown) => void
  pendingClose?: () => Promise<void> | undefined
  canRecoverAfterClose?: () => boolean
}

/** A failed superseded navigation must not put a recovered page back into error state. */
export function createWindowPageLoader(
  load: () => Promise<unknown>,
  failed: (error: unknown) => void
): () => void {
  let attempt = 0
  return () => {
    const current = ++attempt
    try {
      void load().catch((error: unknown) => {
        if (current === attempt) failed(error)
      })
    } catch (error) {
      if (current === attempt) failed(error)
    }
  }
}

/** Native recovery must remain usable even when the renderer/preload is gone. */
export function createWindowFailureRecovery(context: RecoveryContext) {
  let recovered = false
  let failed = false
  let promptOpen = false
  let generation = 0
  // Initial show:false is startup, not a user's choice to leave the app in the background.
  let backgrounded = false
  let waitingForClose: Promise<void> | undefined
  let deferredRecovery: { generation: number; kind: "load" | "crash" } | undefined

  function requestRecovery(kind: "load" | "crash"): void {
    if (!context.isAvailable()) return
    if (!deferredRecovery || deferredRecovery.generation !== generation) {
      deferredRecovery = { generation, kind }
    } else if (kind === "load") deferredRecovery.kind = "load"
    drainRecovery()
  }

  function drainRecovery(): void {
    if (!context.isAvailable() || deferredRecovery?.generation !== generation) {
      deferredRecovery = undefined
      return
    }
    if (promptOpen) return
    const close = context.pendingClose?.()
    if (close || waitingForClose) {
      if (!waitingForClose && close) {
        waitingForClose = close
        const finish = (): void => {
          if (waitingForClose !== close) return
          waitingForClose = undefined
          if (context.canRecoverAfterClose?.() === false) backgrounded = true
          drainRecovery()
        }
        void close.then(finish, (error) => {
          context.reportError(error)
          finish()
        })
      }
      return
    }
    if (backgrounded) return
    const deferred = deferredRecovery
    deferredRecovery = undefined
    if (deferred.kind === "load") void prompt()
    else recoverCrash()
  }

  async function prompt(): Promise<void> {
    if (promptOpen || !context.isAvailable()) return
    promptOpen = true
    const promptGeneration = generation
    let response: number
    try {
      const result = await context.show({
        type: "error",
        title: "界面暂时无法使用",
        message: "界面加载失败或意外停止。",
        detail:
          "可以重新加载界面，或重启应用。任务可能仍在后台运行；重启或退出会中止任务。已保存的会话会保留。",
        buttons: ["重新加载界面", "重启应用", "退出应用", "暂不处理"],
        defaultId: 0,
        cancelId: 3,
        noLink: true
      })
      response = result.response
    } catch (error) {
      context.reportError(error)
      return
    } finally {
      promptOpen = false
    }
    if (!context.isAvailable()) return
    if (promptGeneration !== generation) {
      drainRecovery()
      return
    }
    if (response !== 3 && (context.pendingClose?.() || backgrounded)) {
      requestRecovery("load")
      return
    }
    // This explicit response also acknowledges faults coalesced while the dialog was open.
    deferredRecovery = undefined
    try {
      if (response === 0) {
        failed = false
        context.reload()
      } else if (response === 1) context.restart()
      else if (response === 2) context.quit()
    } catch (error) {
      context.reportError(error)
    }
  }

  function recoverCrash(): void {
    if (!context.isAvailable()) return
    if (!recovered) {
      recovered = true
      try {
        context.reload()
      } catch (error) {
        context.reportError(error)
        failed = true
        requestRecovery("load")
      }
    } else {
      failed = true
      requestRecovery("load")
    }
  }

  return {
    hidden() {
      backgrounded = true
    },
    shown() {
      backgrounded = false
      drainRecovery()
    },
    loading() {
      failed = false
      generation += 1
      deferredRecovery = undefined
    },
    loaded() {
      failed = false
      generation += 1
      deferredRecovery = undefined
    },
    failed(errorCode: number, isMainFrame: boolean) {
      // Navigation cancellation and embedded preview errors do not make the
      // application unusable. Coalesce did-fail-load with loadURL rejection.
      if (errorCode === -3 || !isMainFrame || failed || !context.isAvailable()) return
      failed = true
      requestRecovery("load")
    },
    crashed(reason: string) {
      if (reason === "clean-exit" || !context.isAvailable()) return
      requestRecovery("crash")
    }
  }
}

export async function showStartupFailure(context: Omit<RecoveryContext, "reload">): Promise<void> {
  if (!context.isAvailable()) return
  try {
    const { response } = await context.show({
      type: "error",
      title: "CMBDevClaw 启动失败",
      message: "应用未能完成初始化。",
      detail: "错误已记录到 main.log。可以重启应用后重试；已保存的会话会保留，运行中的任务会中止。",
      buttons: ["重启应用", "退出应用"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (!context.isAvailable()) return
    if (response === 0) context.restart()
    else context.quit()
  } catch (error) {
    context.reportError(error)
    if (context.isAvailable()) context.quit()
  }
}
