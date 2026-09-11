import React from "react"
import { AlertCircle } from "lucide-react"

/**
 * The last boundary before a blank window.
 *
 * Without one, a throw anywhere in the tree unmounts everything and leaves the
 * white window users have reported: no message, no way back, and — because the
 * process is still alive — nothing in the crash logs either. The component
 * stack React hands `componentDidCatch` is the part console output does not
 * reliably carry, and it is what says which component actually failed.
 *
 * Reloading is offered rather than performed. An error that recurs on every
 * render would otherwise reload forever, and the reader would still never see
 * what went wrong.
 */

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (error == null) return "Unknown error"
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

interface Props {
  children: React.ReactNode
}

interface State {
  errorMessage: string | null
  componentStack: string | null
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { errorMessage: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { errorMessage: describeError(error) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const stack = info.componentStack ?? null
    this.setState({ componentStack: stack })
    // Goes through console so the main process picks it up on console-message
    // and writes it to renderer.log — the boundary must not need its own IPC
    // channel to be useful in a packaged build.
    console.error(
      "[AppErrorBoundary] The renderer tree failed to render:",
      error instanceof Error ? (error.stack ?? error.message) : describeError(error),
      "\nComponent stack:",
      stack ?? "unavailable"
    )
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    if (this.state.errorMessage === null) return this.props.children
    return (
      <div role="alert" className="flex h-screen w-screen items-center justify-center bg-background p-8">
        <div className="max-w-2xl space-y-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <h1 className="text-base font-medium">界面渲染失败</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            这次失败已记录到 renderer.log。你可以重新加载界面；任务可能仍在后台运行。
          </p>
          <pre className="max-h-40 overflow-auto rounded bg-muted p-3 text-xs">
            {this.state.errorMessage}
          </pre>
          {this.state.componentStack ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">组件调用栈</summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-3">
                {this.state.componentStack}
              </pre>
            </details>
          ) : null}
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            重新加载
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="ml-3 rounded border px-4 py-2 text-sm"
          >
            关闭窗口
          </button>
        </div>
      </div>
    )
  }
}
