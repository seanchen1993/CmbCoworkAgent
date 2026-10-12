import {
  readBotUserForm,
  hasBotUserFormMarker,
  formatBotUserFormAnswer
} from "../../../../shared/bot-user-form"
import {
  readBotComputerHelp,
  formatBotComputerHelpAnswer
} from "../../../../shared/bot-computer-help"
import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotInteractionDetail, BotRunAddress } from "../../../../shared/bot-run-history"
import { readBotQuestions, formatBotQuestionAnswer } from "../../../../shared/bot-questions"
import { BotApprovalContent } from "./BotApprovalContent"
import { BotEffectDetails } from "./BotEffectDetails"

function answerText(value: BotInteractionDetail["interaction"]): string {
  if (!value.answer) return ""
  const form = value.kind === "question" ? readBotUserForm(value.prompt) : null
  if (hasBotUserFormMarker(value.prompt)) {
    if (!form) return "此表单版本不可用，请核对原请求。"
    try {
      return formatBotUserFormAnswer(form.input, value.answer)
    } catch {
      return "此表单回答格式不可用，请核对原请求。"
    }
  }
  const help = readBotComputerHelp(value.prompt)
  if (help) return formatBotComputerHelpAnswer(help, value.answer)
  const questions = readBotQuestions(value.prompt)
  if (questions) {
    try {
      return formatBotQuestionAnswer(questions, value.answer)
    } catch {
      /* Older response formats remain readable as text. */
    }
  }
  return value.answer
}

export function BotInteractionDetails({
  address,
  interactionId
}: {
  address: BotRunAddress
  interactionId: string
}) {
  const viewVisible = useBotViewVisibility()
  const { conversationId, runId, threadRootId } = address
  const key = JSON.stringify([conversationId, runId, threadRootId, interactionId])
  const [loaded, setLoaded] = useState<{
    key: string
    value: BotInteractionDetail
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const [effect, setEffect] = useState<string | null>(null)
  const value = loaded?.key === key ? loaded.value : null
  const error = failure?.key === key ? failure.message : null
  useEffect(() => {
    if (!viewVisible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const result = await botApi.interactionDetail({
          conversationId,
          runId,
          threadRootId,
          interactionId
        })
        if (disposed) return
        setLoaded({ key, value: result })
        setFailure(null)
        if (result.interaction.status === "pending") timer = setTimeout(() => void read(), 2000)
      } catch (error) {
        if (!disposed)
          setFailure({ key, message: error instanceof Error ? error.message : "请求详情读取失败" })
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [conversationId, runId, threadRootId, interactionId, key, retry, viewVisible])
  const interaction = value?.interaction
  const questions = interaction?.kind === "question" ? readBotQuestions(interaction.prompt) : null
  const form = interaction?.kind === "question" ? readBotUserForm(interaction.prompt) : null
  const status =
    interaction?.status === "answered"
      ? interaction.answer === "reject"
        ? "已拒绝"
        : value?.secret
          ? "安全输入已完成"
          : interaction.kind === "approval"
            ? "已批准"
            : "已回复"
      : ({ pending: "等待处理", expired: "已过期", cancelled: "已取消" } as const)[
          interaction?.status ?? "pending"
        ]
  return (
    <div className="space-y-4 rounded-xl border bg-muted/20 p-4" aria-label="请求详情">
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {!value && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取请求详情…
        </p>
      )}
      {value && interaction && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <strong className="font-medium">{status}</strong>
            <time
              className="text-muted-foreground"
              dateTime={new Date(interaction.createdAt).toISOString()}
            >
              {new Date(interaction.createdAt).toLocaleString()}
            </time>
          </div>
          {interaction.review &&
            (interaction.review.source === "rule" || interaction.review.remembered) && (
              <p className="text-xs text-muted-foreground">
                {interaction.review.source === "rule"
                  ? "已按你保存的相同命令规则自动批准。"
                  : "本次批准已保存为相同命令规则，可在审批规则中修改。"}
              </p>
            )}
          {interaction.autoReview && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              独立审核{interaction.autoReview.decision === "allow" ? "已批准" : "转人工确认"}：
              {interaction.autoReview.reason}
            </p>
          )}
          {value.secret ? (
            <section className="space-y-2 text-sm">
              <h4 className="flex items-center gap-2 font-medium">
                <ShieldCheck size={16} />
                {value.secret.label}
              </h4>
              <p className="break-all text-xs text-muted-foreground">
                {value.secret.origin} · {value.secret.field}
              </p>
              {interaction.prompt && (
                <p className="whitespace-pre-wrap break-words">{interaction.prompt}</p>
              )}
              <p className="text-xs text-muted-foreground">安全输入内容不保存在任务记录中。</p>
            </section>
          ) : interaction.kind === "approval" ? (
            <BotApprovalContent prompt={interaction.prompt} />
          ) : (
            <section className="space-y-2 text-sm">
              <h4 className="text-xs font-medium text-muted-foreground">当时的问题</h4>
              {form ? (
                <div className="space-y-2">
                  <p className="font-medium">{form.input.title}</p>
                  {form.input.description && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {form.input.description}
                    </p>
                  )}
                  <ul className="space-y-1 text-muted-foreground">
                    {form.input.fields.map((field) => (
                      <li key={field.id}>
                        {field.label} · {field.required ? "必填" : "选填"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : hasBotUserFormMarker(interaction.prompt) ? (
                <p>此表单版本不可用，请核对原请求。</p>
              ) : questions ? (
                <ol className="list-inside list-decimal space-y-2">
                  {questions.questions.map((q) => (
                    <li key={q.id} className="whitespace-pre-wrap break-words">
                      {q.question}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {readBotComputerHelp(interaction.prompt)?.instruction ?? interaction.prompt}
                </p>
              )}
              {interaction.answer && (
                <>
                  <h4 className="pt-2 text-xs font-medium text-muted-foreground">用户回复</h4>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-sans text-sm [overflow-wrap:anywhere]">
                    {answerText(interaction)}
                  </pre>
                </>
              )}
            </section>
          )}
          {value.effects.length > 0 ? (
            <section className="space-y-2">
              {value.effects.map((item) => (
                <div key={item.id} className="space-y-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={effect === item.id}
                    onClick={() => setEffect((current) => (current === item.id ? null : item.id))}
                  >
                    {effect === item.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    查看对应操作结果
                  </Button>
                  {effect === item.id && (
                    <BotEffectDetails address={address} effectId={item.id} showApproval={false} />
                  )}
                </div>
              ))}
            </section>
          ) : (
            interaction.kind === "approval" &&
            !value.secret && (
              <p className="text-xs text-muted-foreground">
                {interaction.answer === "reject"
                  ? "此请求未获批准，没有对应的操作回执。"
                  : "此请求暂无关联的操作回执，批准状态不代表执行已完成。"}
              </p>
            )
          )}
        </>
      )}
    </div>
  )
}
