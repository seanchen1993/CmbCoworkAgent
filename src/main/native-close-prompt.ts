import type { MessageBoxOptions } from "electron"

interface NativeCloseContext {
  isAvailable: () => boolean
  hasActiveRuns: () => boolean
  hasTray: () => boolean
  show: (options: MessageBoxOptions) => Promise<{ response: number }>
  minimize: () => void
  quit: () => void
}

/** Independent of renderer IPC, with one dialog and explicit confirmation even
 * when work starts or the tray disappears while the native dialog is open.
 */
export function createNativeClosePrompt() {
  let open = false
  let generation = 0
  return {
    get isOpen() {
      return open
    },
    cancel() {
      generation += 1
    },
    async request(context: NativeCloseContext): Promise<void> {
      if (open || !context.isAvailable()) return
      open = true
      const requestGeneration = generation
      try {
        while (requestGeneration === generation && context.isAvailable()) {
          const activeRuns = context.hasActiveRuns()
          const tray = context.hasTray()
          const { response } = await context.show({
            type: "warning",
            title: "关闭 CMBDevClaw",
            message: activeRuns ? "仍有任务正在运行，是否退出应用？" : "是否关闭应用？",
            detail: activeRuns
              ? "退出会中止正在运行的任务。你也可以取消关闭，或在系统托盘可用时留在后台。"
              : "页面未能显示关闭提示，请在此选择。",
            buttons: tray ? ["取消", "退出应用", "留在后台"] : ["取消", "退出应用"],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          if (requestGeneration !== generation || !context.isAvailable()) return
          if (response === 1) {
            if (!activeRuns && context.hasActiveRuns()) continue
            context.quit()
          } else if (response === 2 && tray) {
            if (!context.hasTray()) continue
            context.minimize()
          }
          return
        }
      } finally {
        open = false
      }
    }
  }
}
