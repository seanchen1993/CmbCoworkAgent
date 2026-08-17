import type { BrowserWindow } from "electron"
import type { AgentStreamDisplayInterest } from "../../shared/agent-stream-display-interest"

// 主进程的流式显示门控：后台或隐藏线程只保留最新快照，恢复可见时补发，避免逐 chunk 压垮渲染层。
interface AgentStreamDisplaySnapshot {
  runToken: string
  sequence: number
  channel: string
  mode: string
  data: unknown
}

interface AgentStreamDisplayGateOptions {
  isThreadRunActive: (threadId: string) => boolean
  send: (window: BrowserWindow, channel: string, payload: unknown) => void
}

// This is display-only backpressure. It never changes agent execution,
// transcript persistence, or the existing renderer stream event protocol.
export class AgentStreamDisplayGate {
  private readonly interestByWindow = new Map<number, Map<string, AgentStreamDisplayInterest>>()
  private readonly snapshotsByWindow = new Map<
    number,
    Map<string, Map<string, AgentStreamDisplaySnapshot>>
  >()
  private readonly trackedWindows = new Set<number>()
  private sequence = 0

  constructor(private readonly options: AgentStreamDisplayGateOptions) {}

  shouldSendImmediately(window: BrowserWindow, threadId: string): boolean {
    const interest = this.interestByWindow.get(window.id)?.get(threadId)
    if (interest !== "background" && interest !== "hidden") return true
    // Without a complete values frame, replaying only the latest delta cannot
    // reconstruct the renderer state safely.
    return !this.snapshotsByWindow.get(window.id)?.get(threadId)?.has("values")
  }

  remember(
    window: BrowserWindow,
    threadId: string,
    runToken: string,
    channel: string,
    mode: string,
    data: unknown
  ): void {
    let snapshotsByThread = this.snapshotsByWindow.get(window.id)
    if (!snapshotsByThread) {
      snapshotsByThread = new Map()
      this.snapshotsByWindow.set(window.id, snapshotsByThread)
    }
    let snapshotsByMode = snapshotsByThread.get(threadId)
    if (!snapshotsByMode) {
      snapshotsByMode = new Map()
      snapshotsByThread.set(threadId, snapshotsByMode)
    }
    snapshotsByMode.set(mode, {
      runToken,
      sequence: ++this.sequence,
      channel,
      mode,
      data
    })
  }

  clearThread(threadId: string, runToken?: string): void {
    for (const [windowId, snapshotsByThread] of this.snapshotsByWindow) {
      const snapshotsByMode = snapshotsByThread.get(threadId)
      if (!snapshotsByMode) continue
      for (const [mode, snapshot] of snapshotsByMode) {
        if (!runToken || snapshot.runToken === runToken) snapshotsByMode.delete(mode)
      }
      if (snapshotsByMode.size === 0) snapshotsByThread.delete(threadId)
      if (snapshotsByThread.size === 0) this.snapshotsByWindow.delete(windowId)
    }
  }

  setInterest(
    window: BrowserWindow,
    threadId: string,
    interest: AgentStreamDisplayInterest
  ): boolean {
    let interests = this.interestByWindow.get(window.id)
    if (!interests) {
      interests = new Map()
      this.interestByWindow.set(window.id, interests)
    }
    interests.set(threadId, interest)
    if (interest !== "foreground") return false
    return this.sendLatestSnapshot(window, threadId)
  }

  trackWindow(window: BrowserWindow): void {
    if (this.trackedWindows.has(window.id)) return
    this.trackedWindows.add(window.id)
    window.once("closed", () => {
      this.trackedWindows.delete(window.id)
      this.interestByWindow.delete(window.id)
      this.snapshotsByWindow.delete(window.id)
    })
  }

  private sendLatestSnapshot(window: BrowserWindow, threadId: string): boolean {
    if (!this.options.isThreadRunActive(threadId)) return false
    const snapshotsByMode = this.snapshotsByWindow.get(window.id)?.get(threadId)
    if (!snapshotsByMode) return false

    // A values frame is a complete current-turn state. Prefer it over a stale
    // delta when a thread becomes visible again.
    const valuesSnapshot = snapshotsByMode.get("values")
    const snapshots = valuesSnapshot
      ? [valuesSnapshot]
      : [...snapshotsByMode.values()].sort((left, right) => left.sequence - right.sequence)
    for (const snapshot of snapshots) {
      this.options.send(window, snapshot.channel, {
        type: "stream",
        mode: snapshot.mode,
        data: snapshot.data
      })
    }
    return snapshots.length > 0
  }
}
