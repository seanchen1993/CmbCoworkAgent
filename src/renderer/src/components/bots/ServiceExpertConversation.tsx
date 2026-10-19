import { useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowUp, Check, Loader2, RefreshCw, Settings2, Square } from "lucide-react"
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown"
import { BotAvatar } from "./BotAvatar"
import { formatMessageTimeLabel } from "@/lib/message-bubble-timing"
import { useAppStore } from "@/lib/store"
import { SERVICE_NEW_TASK, serviceBusy, type ServiceExpertChats } from "./useServiceExpertChats"
import type { ServiceRequestStatus } from "../../../../shared/bot/service-conversation"
export { SERVICE_EXPERT_SELECTION } from "./useServiceExpertChats"
export const SERVICE_STATUS: Record<ServiceRequestStatus, string> = {
  saved: "已保存",
  next_round: "等待下一轮",
  submitting: "正在保存",
  queued: "等待执行",
  waiting_node: "等待设备上线",
  starting: "准备回复",
  running: "正在处理",
  succeeded: "已回复",
  failed: "回复失败",
  cancelled: "已停止",
  outcome_unknown: "结果待核对",
  blocked: "受阻"
}
/** Pure service chat surface: same Beta header/bubble/composer tokens, with no
 * personal Thread, attachment route, visual editing or local Bot submission. */
export function ServiceExpertConversation({
  controller: c,
  taskRef,
  onSelect
}: {
  controller: ServiceExpertChats
  taskRef: string | null
  onSelect: (ref: string | null) => void
}) {
  const [settings, setSettings] = useState(false)
  const viewport = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    snapshot = useRef<{
      ref: string | null
      first: string | undefined
      count: number
      height: number
    } | null>(null)
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const previous = snapshot.current,
      first = c.entries[0]?.requestId
    if (!previous || previous.ref !== taskRef) {
      pinned.current = true
      el.scrollTop = el.scrollHeight
    } else if (previous.first && previous.first !== first && c.entries.length > previous.count)
      el.scrollTop += el.scrollHeight - previous.height
    else if (pinned.current) el.scrollTop = el.scrollHeight
    snapshot.current = { ref: taskRef, first, count: c.entries.length, height: el.scrollHeight }
  }, [c.entries, taskRef])
  const send = () => {
    pinned.current = true
    void c.send()
  }
  const info = c.overview,
    name = info?.expertName ?? "服务专家",
    completed = c.task?.taskStatus === "completed"
  const actual = [...c.entries].reverse().find(serviceBusy)
  const configure = () => useAppStore.getState().setShowCustomizeView(true, "partnerDev")
  return (
    <>
      <header className="bot-chat-header">
        {taskRef && (
          <button
            className="bot-icon-button service-chat-back"
            aria-label="回到专家主对话"
            title="回到专家主对话"
            onClick={() => onSelect(null)}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div
          className="bot-title-pill"
          title={
            taskRef
              ? (c.task?.title ?? (taskRef === SERVICE_NEW_TASK ? "新任务" : "任务会话"))
              : name
          }
        >
          <BotAvatar color="#168bea" shape="circle" size={24} />
          <span>
            {taskRef
              ? (c.task?.title ?? (taskRef === SERVICE_NEW_TASK ? "新任务" : "任务会话"))
              : name}
          </span>
        </div>
        <button
          className="bot-icon-button"
          aria-label="会话设置"
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={18} />
        </button>
      </header>
      {settings && (
        <div className="service-chat-settings">
          <label>
            模型{" "}
            <select
              aria-label="服务模型"
              value={info?.selectedModel?.ref ?? ""}
              disabled={c.working || !info?.conversationId}
              onChange={(e) => {
                void c.selectModel(e.target.value)
              }}
            >
              <option value="" disabled>
                选择模型
              </option>
              {info?.models.map((model) => (
                <option key={model.ref} value={model.ref}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <span>{info?.nodeEnabled ? "本机已启用" : "等待本机启用"}</span>
          <button onClick={configure}>配置专家与设备</button>
        </div>
      )}
      {c.error && (
        <div className="bot-notice" role="alert">
          {c.error}
          <button
            onClick={() => {
              void c.reload()
              void c.refresh()
            }}
          >
            刷新
          </button>
        </div>
      )}
      {!info?.conversationId ? (
        <div className="bot-empty">
          <p>{info ? "连接服务后即可和专家聊天" : "正在读取专家…"}</p>
          <button className="bot-settings-button" onClick={configure}>
            配置服务专家
          </button>
        </div>
      ) : (
        <>
          {taskRef && taskRef !== SERVICE_NEW_TASK && (
            <div className="service-chat-task-bar">
              <span>{completed ? "任务已完成" : "任务处理中"}</span>
              <button
                disabled={c.working || (!completed && (!!actual || c.task?.busy))}
                onClick={() => {
                  void c.lifecycle(completed ? "reopen" : "complete")
                }}
              >
                <Check size={14} />
                {completed ? "继续处理" : "完成"}
              </button>
            </div>
          )}
          <div
            ref={viewport}
            onScroll={() => {
              const el = viewport.current
              if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="service-chat-transcript"
            data-chat-surface="bot"
            aria-label={taskRef ? "任务消息" : "专家主对话消息"}
          >
            <div className="service-chat-column">
              {c.entryCursor && (
                <button
                  className="service-chat-more"
                  disabled={c.working}
                  onClick={() => {
                    void c.moreEntries()
                  }}
                >
                  加载更早消息
                </button>
              )}
              {!c.entries.length && (
                <div className="bot-empty">
                  <p>
                    {taskRef ? "在这里讨论和修改这项任务" : `和 ${name} 聊聊，或明确交办一项任务`}
                  </p>
                </div>
              )}
              {c.entries.map((entry) => (
                <section
                  key={entry.requestId}
                  className="service-chat-exchange"
                  data-request-id={entry.requestId}
                >
                  <div data-message-bubble="user">
                    <div>
                      <div data-message-body="user">
                        <p>{entry.text}</p>
                      </div>
                    </div>
                  </div>
                  <div className="service-chat-reply">
                    <BotAvatar color="#168bea" shape="circle" size={26} />
                    <div className="service-chat-answer">
                      {entry.result?.outcome === "succeeded" && (
                        <div data-message-body="assistant">
                          <StreamingMarkdown isStreaming={false}>
                            {entry.result.text}
                          </StreamingMarkdown>
                        </div>
                      )}
                      {entry.coordination?.state === "delivered" && entry.coordination.taskRef && (
                        <button
                          className="service-chat-task-link"
                          onClick={() => onSelect(entry.coordination!.taskRef)}
                        >
                          <span>{entry.coordination.title ?? "任务会话"}</span>
                          <ArrowUp size={15} />
                        </button>
                      )}
                      <div className="service-chat-state">
                        <span>{SERVICE_STATUS[entry.status]}</span>
                        <time>
                          {formatMessageTimeLabel(
                            Date.parse(entry.result?.settledAt ?? entry.createdAt)
                          )}
                        </time>
                        {serviceBusy(entry) && (
                          <button
                            aria-label="停止当前请求"
                            disabled={c.working}
                            onClick={() => {
                              void c.cancel(entry.requestId)
                            }}
                          >
                            <Square size={12} />
                            停止
                          </button>
                        )}
                        {!entry.supersededBy &&
                          ["failed", "blocked", "cancelled"].includes(entry.status) && (
                            <button
                              disabled={c.working}
                              onClick={() => {
                                void c.retry(entry.requestId)
                              }}
                            >
                              <RefreshCw size={12} />
                              重试
                            </button>
                          )}
                      </div>
                      {entry.notice && <p className="service-chat-notice">{entry.notice}</p>}
                      {entry.coordination?.state === "blocked" && (
                        <p className="service-chat-notice">交办未完成，请核对服务状态。</p>
                      )}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          </div>
          <div className="service-chat-composer-wrap" data-chat-surface="bot">
            <form
              className="service-chat-composer"
              onSubmit={(e) => {
                e.preventDefault()
                send()
              }}
            >
              <textarea
                className="composer-textarea"
                aria-label={taskRef ? "给任务发消息" : "给专家发消息"}
                placeholder={
                  completed
                    ? "任务已完成，点击继续处理后可再发消息"
                    : taskRef
                      ? "讨论、补充或修改这项任务…"
                      : `给 ${name} 发消息…`
                }
                value={c.draft}
                disabled={completed}
                onChange={(e) => c.setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <div>
                <button
                  type="button"
                  className="service-chat-model"
                  onClick={() => setSettings(!settings)}
                >
                  {info.selectedModel?.name ?? "选择模型"}
                </button>
                <button
                  type="submit"
                  className="service-chat-send"
                  aria-label="发送消息"
                  disabled={completed || c.working || !c.draft.trim() || !info.selectedModel}
                >
                  {c.working ? (
                    <Loader2 size={17} className="animate-spin" />
                  ) : (
                    <ArrowUp size={17} />
                  )}
                </button>
              </div>
            </form>
            <p className="service-chat-hint">仅处理你提供的文本 · 结果供参考</p>
          </div>
        </>
      )}
    </>
  )
}
