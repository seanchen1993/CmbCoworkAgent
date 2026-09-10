import { Component, type ErrorInfo, type ReactNode } from "react"

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary] 页面渲染失败", error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-8 text-foreground"
      >
        <h1 className="text-xl font-semibold">页面出现异常</h1>
        <p className="max-w-lg text-center text-sm text-muted-foreground">
          任务可能仍在后台运行。你可以关闭窗口选择留在后台，或退出应用后重新打开。
        </p>
        <button className="rounded-md border px-4 py-2 text-sm" onClick={() => window.close()}>
          关闭窗口
        </button>
      </main>
    )
  }
}
