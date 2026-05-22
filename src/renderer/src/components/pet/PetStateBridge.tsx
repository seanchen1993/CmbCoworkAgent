import { useEffect, useMemo, useRef } from "react"
import { useAppStore } from "@/lib/store"
import { useAllStreamLoadingStates, useThreadState } from "@/lib/thread-context"

type PetState = "idle" | "busy" | "waiting" | "done" | "error" | "crying" | "prompt"

// 只负责把 renderer 中可观察到的任务状态桥接给主进程宠物窗口。
// 宠物绘制、拖拽、hover、点击等桌面交互都在主进程独立 BrowserWindow 中处理。
export function PetStateBridge(): null {
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const loadingStates = useAllStreamLoadingStates()
  const currentThreadState = useThreadState(currentThreadId)
  const previousRunningRef = useRef(false)
  const lastSentStateRef = useRef<PetState | null>(null)
  const doneTimerRef = useRef<number | null>(null)

  const anyRunning = useMemo(() => Object.values(loadingStates).some(Boolean), [loadingStates])
  // 大模型失败或 Hook 中断时显示哭泣；错误未清除前会持续哭泣。
  const hasCurrentError = Boolean(currentThreadState?.error || currentThreadState?.hookInterruption)
  // pendingApproval 表示 AI 等用户输入/审批，对应 waiting 动画。
  const needsInput = Boolean(currentThreadState?.pendingApproval)

  useEffect(() => {
    const sendPetState = (state: PetState): void => {
      // 避免重复发送相同状态，减少主进程 executeJavaScript 调用。
      if (lastSentStateRef.current === state) return
      lastSentStateRef.current = state
      window.api.pet.setState(state)
    }

    if (doneTimerRef.current !== null) {
      // done 是一次性反馈；任何新状态到来都要清掉回 idle 的旧定时器。
      window.clearTimeout(doneTimerRef.current)
      doneTimerRef.current = null
    }

    if (hasCurrentError) {
      sendPetState("crying")
    } else if (needsInput) {
      sendPetState("waiting")
    } else if (anyRunning) {
      sendPetState("busy")
    } else if (previousRunningRef.current) {
      // 从运行中切回空闲时短暂展示完成动画，然后回到 idle。
      sendPetState("done")
      doneTimerRef.current = window.setTimeout(() => sendPetState("idle"), 2200)
    } else {
      sendPetState("idle")
    }

    previousRunningRef.current = anyRunning

    return () => {
      if (doneTimerRef.current !== null) {
        window.clearTimeout(doneTimerRef.current)
        doneTimerRef.current = null
      }
    }
  }, [anyRunning, hasCurrentError, needsInput])

  return null
}
