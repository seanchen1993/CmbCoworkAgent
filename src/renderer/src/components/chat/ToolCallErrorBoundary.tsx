import React from "react"
import { AlertCircle } from "lucide-react"

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err) return err
  if (err == null) return "Unknown error"
  try {
    // JSON.stringify returns undefined for Symbol, function, bigint in some
    // runtimes — fall through to String() so the fallback UI is never blank.
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

interface Props {
  children: React.ReactNode
  toolName?: string
  /**
   * Semantic signal for "the data driving children has materially changed".
   * When this value differs from the previous render while we're in an
   * error state, reset and retry rendering. Using children reference
   * comparison instead would reset every parent re-render (children JSX
   * is always a new reference), causing flicker.
   */
  resetKey?: string | number
}

interface State {
  errorMessage: string | null
}

export class ToolCallErrorBoundary extends React.Component<Props, State> {
  state: State = { errorMessage: null }

  // React may pass any thrown value (not just Error instances), so treat
  // the argument as unknown and normalise it to a string.
  static getDerivedStateFromError(error: unknown): State {
    return { errorMessage: describeError(error) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.warn(
      `[ToolCallErrorBoundary] Render failed for tool "${this.props.toolName ?? "unknown"}":`,
      error,
      info.componentStack
    )
  }

  // If we're currently in an error state and the parent signals a
  // meaningful data change via resetKey, retry rendering. Falls back
  // to children-reference comparison when no resetKey is provided.
  componentDidUpdate(prevProps: Readonly<Props>): void {
    if (this.state.errorMessage === null) return
    const changed = prevProps.resetKey !== undefined || this.props.resetKey !== undefined
      ? prevProps.resetKey !== this.props.resetKey
      : prevProps.children !== this.props.children
    if (changed) this.setState({ errorMessage: null })
  }

  render(): React.ReactNode {
    if (this.state.errorMessage !== null) {
      return (
        <div className="flex items-start gap-1.5 text-xs text-status-critical px-2 py-1.5 rounded bg-status-critical/10">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-medium">工具渲染失败（{this.props.toolName ?? "unknown"}）</div>
            <div className="text-status-critical/80 break-words overflow-auto max-h-40">
              {this.state.errorMessage}
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Stable host component: evaluates a render callback during its own render
 * phase so any throw from the callback is caught by a surrounding
 * ToolCallErrorBoundary. Because this component is defined at module level
 * it has a stable identity across parent re-renders — unlike inline
 * components defined inside a parent's render (which React would remount
 * every time, blowing away any child state).
 */
export function RenderProbe({ render }: { render: () => React.ReactNode }): React.ReactNode {
  return render()
}
