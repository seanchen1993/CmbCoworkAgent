import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useThreadContext } from "@/lib/thread-context"
import {
  completeBotConversationDeletion,
  completeBotConversationTransition,
  type BotConversationDeletionRequest
} from "@/lib/bot-conversation-transition"
import { botErrorMessage } from "@/lib/bot-error-message"
import { useAppStore } from "@/lib/store"
import { ThreadDeleteDialog } from "@/components/sidebar/ThreadDeleteDialog"
import type { BotConversationTransitionRequest } from "../../../../shared/bots/conversation"
import { BotUnlinkDialog } from "./BotUnlinkDialog"
import { returnToBotTask } from "./ConversationTaskControls"

type UnlinkRequest = Extract<BotConversationTransitionRequest, { action: "unlink" }>

export function BotConversationTransitions() {
  const context = useThreadContext()
  const latestContext = useRef(context)
  latestContext.current = context
  const pendingDeletion = useRef<BotConversationDeletionRequest | null>(null)
  const confirmingDeletion = useRef(false)
  const [deletion, setDeletion] = useState<BotConversationDeletionRequest | null>(null)
  const [confirming, setConfirming] = useState(false)
  const pendingUnlink = useRef<UnlinkRequest | null>(null)
  const confirmingUnlink = useRef(false)
  const [unlink, setUnlink] = useState<UnlinkRequest | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const dismissDeletion = useCallback((id: string) => {
    if (pendingDeletion.current?.id !== id) return
    pendingDeletion.current = null
    setDeletion(null)
  }, [])
  const dismissUnlink = useCallback((id: string) => {
    if (pendingUnlink.current?.id !== id) return
    pendingUnlink.current = null
    setUnlink(null)
  }, [])

  useEffect(() => {
    const client = window.api.bots?.conversations
    const finish = client?.finishTransition
    if (!client?.onTransition || !finish) return
    const pendingLinks = new Map<string, { id: string; controller: AbortController }>()
    const unsubscribeDismissed = client.onTransitionDismissed?.(id => {
      dismissDeletion(id)
      dismissUnlink(id)
      for (const link of pendingLinks.values()) {
        if (link.id === id) link.controller.abort()
      }
    })
    const refresh = () => useAppStore.getState().loadThreads()
    const decline = (id: string, reason: string) =>
      void finish(id, reason).catch(error => console.warn("[Bots] Failed to decline transition:", error))
    const unsubscribe = client.onTransition((request) => {
      if (request.action === "delete") {
        if (pendingDeletion.current?.id === request.id) return
        if (pendingDeletion.current || confirmingDeletion.current || pendingUnlink.current || confirmingUnlink.current) {
          decline(request.id, "已有会话变更等待处理。")
          return
        }
        pendingDeletion.current = request
        setDeletion(request)
        return
      }
      if (request.action === "unlink") {
        if (pendingUnlink.current?.id === request.id) return
        if (pendingUnlink.current || confirmingUnlink.current || pendingDeletion.current || confirmingDeletion.current) {
          decline(request.id, "已有会话变更等待处理。")
          return
        }
        const inspect = client.unlinkHasOpenPages
        if (!inspect) {
          decline(request.id, "无法核对原任务的电脑状态。")
          return
        }
        pendingUnlink.current = request
        const { bot, work } = request.link
        void inspect(bot.id, work.id).then(hasOpenPages => {
          if (pendingUnlink.current?.id !== request.id) return
          if (hasOpenPages) {
            setUnlink(request)
            return
          }
          return completeBotConversationTransition(latestContext.current, request, finish, refresh)
            .finally(() => dismissUnlink(request.id))
        }).catch(error => {
          if (pendingUnlink.current?.id === request.id) {
            decline(request.id, botErrorMessage(error).slice(0, 1000))
            dismissUnlink(request.id)
          }
          console.warn("[Bots] Conversation transition failed:", error)
        })
        return
      }
      const pending = pendingLinks.get(request.threadId)
      if (pending?.id === request.id) return
      if (pending) {
        decline(request.id, "原会话已有一项关联正在处理。")
        return
      }
      const controller = new AbortController()
      pendingLinks.set(request.threadId, { id: request.id, controller })
      void completeBotConversationTransition(latestContext.current, request, finish, refresh, controller.signal)
        .catch(error => console.warn("[Bots] Conversation transition failed:", error))
        .finally(() => pendingLinks.delete(request.threadId))
    })
    return () => {
      unsubscribe()
      unsubscribeDismissed?.()
      for (const link of pendingLinks.values()) link.controller.abort()
    }
  }, [dismissDeletion, dismissUnlink])

  const cancelDeletion = (id: string) => {
    if (pendingDeletion.current?.id !== id || confirmingDeletion.current) return
    dismissDeletion(id)
    void window.api.bots.conversations?.finishTransition?.(id, "已取消删除")
      .catch((error) => console.warn("[Bots] Failed to cancel deletion:", error))
  }

  const confirmDeletion = async (id: string) => {
    const finish = window.api.bots.conversations?.finishTransition
    if (pendingDeletion.current?.id !== id || !finish || confirmingDeletion.current) return
    confirmingDeletion.current = true
    setConfirming(true)
    try {
      const error = await completeBotConversationDeletion(context, id, finish)
      if (error) toast.error(error)
    } catch (error) {
      toast.error(botErrorMessage(error, "删除失败，请重试。"))
    } finally {
      dismissDeletion(id)
      confirmingDeletion.current = false
      setConfirming(false)
    }
  }
  const cancelUnlink = (id: string) => {
    if (pendingUnlink.current?.id !== id || confirmingUnlink.current) return
    dismissUnlink(id)
    void window.api.bots.conversations?.finishTransition?.(id, "已取消解除任务关联")
      .catch(error => console.warn("[Bots] Failed to cancel unlink:", error))
  }
  const confirmUnlink = async (request: UnlinkRequest) => {
    const finish = window.api.bots.conversations?.finishTransition
    if (!finish || pendingUnlink.current?.id !== request.id || confirmingUnlink.current) return
    confirmingUnlink.current = true
    setUnlinking(true)
    try {
      await completeBotConversationTransition(latestContext.current, request, finish, () =>
        useAppStore.getState().loadThreads())
    } catch (error) {
      toast.error(botErrorMessage(error, "解除关联失败，请重试。"))
    } finally {
      dismissUnlink(request.id)
      confirmingUnlink.current = false
      setUnlinking(false)
    }
  }

  const target = deletion?.work ? "Bot 任务" : "会话"
  const scope = deletion?.work && deletion.threadId ? "及其会话" : ""
  return (
    <>
      <ThreadDeleteDialog
        open={Boolean(deletion)}
        title={`确认删除${target}`}
        description={`确定要删除${target}「${deletion?.title ?? ""}」${scope}吗？删除后不可恢复。`}
        confirming={confirming}
        onCancel={() => {
          if (deletion) cancelDeletion(deletion.id)
        }}
        onConfirm={(event) => {
          if (event.isTrusted && deletion) void confirmDeletion(deletion.id)
        }}
      />
      {unlink && (
        <BotUnlinkDialog
          key={unlink.id}
          link={unlink.link}
          hasOpenPages
          confirming={unlinking}
          onCancel={() => cancelUnlink(unlink.id)}
          onConfirm={() => void confirmUnlink(unlink)}
          onReturn={tab => returnToBotTask(unlink.link, tab)}
        />
      )}
    </>
  )
}
