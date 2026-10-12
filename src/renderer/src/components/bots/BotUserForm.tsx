import { useId, useLayoutEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Loader2, MessageSquareText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  botUserFormPending,
  reconcileBotUserFormAnswer,
  type BotUserFormPendingInput
} from "@/lib/bot-user-form-pending"
import type { BotInteraction } from "../../../../shared/bot-types"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import {
  botUserFormValueError,
  readBotUserForm,
  validateBotUserFormAnswer,
  type BotUserFormCard
} from "../../../../shared/bot-user-form"

/** Typed ordinary questions share the original answer RPC and SQLite receipt.
 * useBotEpochOperation requires a nonce; this receipt uses the original revision
 * instead. Reuse protected pending and its mounted/generation/epoch ownership. */
export function BotUserForm(props: {
  item: BotInteraction
  card: BotUserFormCard
  address: BotRunAddress
  refresh(): Promise<void>
}) {
  const identity = JSON.stringify([
    props.item.id,
    props.item.revision,
    props.address.conversationId,
    props.address.runId,
    props.address.threadRootId,
    props.card.dataEpoch
  ])
  return <BotUserFormBody key={identity} {...props} identity={identity} />
}

function BotUserFormBody({
  item,
  card,
  address,
  refresh,
  identity
}: {
  item: BotInteraction
  card: BotUserFormCard
  address: BotRunAddress
  refresh(): Promise<void>
  identity: string
}) {
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("typed-user-forms") ?? false
  )
  const currentEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [scope] = useState(identity),
    config = useRef({ identity, refresh })
  useLayoutEffect(() => {
    config.current = { identity, refresh }
  }, [identity, refresh])
  const owner = useRef({ mounted: false, generation: 0, saving: false })
  useLayoutEffect(() => {
    const current = owner.current
    current.mounted = true
    ++current.generation
    return () => {
      current.mounted = false
      ++current.generation
    }
  }, [])
  const current = () =>
    config.current.identity === scope &&
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === card.dataEpoch
  const [record, setRecord] = useState(() => botUserFormPending.inspect(item.id, card.dataEpoch))
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (record.kind !== "valid") return {}
    try {
      const answer = JSON.parse(validateBotUserFormAnswer(card.input, record.input.answer))
      return answer.status === "submitted" ? answer.values : {}
    } catch {
      return {}
    }
  })
  const [busy, setBusy] = useState(false),
    [retired, setRetired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false),
    [collapsed, setCollapsed] = useState(false)
  const fieldPrefix = useId(),
    titleId = useId()
  const errors = Object.fromEntries(
    card.input.fields.map((field) => [field.id, botUserFormValueError(field, values[field.id])])
  )
  const restored = currentEpoch !== card.dataEpoch || retired
  const disabled = busy || restored || !supported || record.kind !== "empty"
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const matches = (input: BotUserFormPendingInput) =>
    input.id === item.id &&
    input.runId === address.runId &&
    input.conversationId === address.conversationId &&
    input.threadRootId === address.threadRootId &&
    input.revision === item.revision &&
    input.dataEpoch === card.dataEpoch
  const read = (input: BotUserFormPendingInput) =>
    botApi.interactionDetail({
      interactionId: input.id,
      conversationId: input.conversationId,
      runId: input.runId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {})
    })
  const submit = async (cancel = false) => {
    if (
      !owner.current.mounted ||
      !current() ||
      owner.current.saving ||
      !supported ||
      restored ||
      blocked
    )
      return
    const generation = owner.current.generation,
      live = () => owner.current.mounted && owner.current.generation === generation && current()
    owner.current.saving = true
    setBusy(true)
    setError(null)
    setAttempted(true)
    try {
      const present = botUserFormPending.inspect(item.id, card.dataEpoch)
      if (present.kind !== "empty" && present.kind !== "valid") {
        if (live()) {
          setRecord(present)
          setError("无法核对本机原提交，本次尚未提交。")
        }
        return
      }
      if (present.kind === "valid" && (record.kind !== "valid" || record.raw !== present.raw)) {
        if (!matches(present.input)) throw new Error("本机原提交不属于当前表单，请先核对原请求。")
        const frozen = JSON.parse(validateBotUserFormAnswer(card.input, present.input.answer))
        if (live()) {
          setRecord(present)
          setValues(frozen.status === "submitted" ? frozen.values : {})
          setAttempted(false)
          setError("另一次提交尚未确认，已显示原回答。请核对后确认原提交。")
        }
        // Newly discovered cross-window submission is not the draft reviewed by
        // this click. Display its exact payload before allowing confirmation.
        return
      }
      if (present.kind === "empty" && !cancel && Object.values(errors).some(Boolean)) return
      const input: BotUserFormPendingInput =
        present.kind === "valid"
          ? present.input
          : {
              id: item.id,
              revision: item.revision,
              ...address,
              dataEpoch: card.dataEpoch,
              answer: validateBotUserFormAnswer(
                card.input,
                JSON.stringify({
                  status: cancel ? "cancelled" : "submitted",
                  values: cancel ? {} : values
                })
              ),
              storedAt: Date.now()
            }
      if (!matches(input)) throw new Error("本机原提交不属于当前表单，请先核对原请求。")
      botUserFormPending.remember(input)
      if (!live()) return
      setRecord(botUserFormPending.inspect(item.id, card.dataEpoch))
      // Reconciliation is a scoped read; disappearance from snapshot is not ACK.
      const detail = await read(input)
      if (!live()) return
      const state = reconcileBotUserFormAnswer(input, detail)
      if (state === "conflict")
        throw new Error("原请求或回答已变化。原提交记录仍保留，请核对历史。")
      if (state === "retired") {
        botUserFormPending.acknowledge(input)
        if (live()) {
          setRetired(true)
          setError("原请求已过期或取消，没有再次提交。")
        }
        if (live()) await config.current.refresh()
        return
      }
      if (state === "pending") {
        const result = await botApi.answer({
          id: input.id,
          revision: input.revision,
          answer: input.answer,
          expectedDataEpoch: input.dataEpoch
        })
        const response = readBotUserForm(result.prompt)
        if (
          result.id !== input.id ||
          result.runId !== input.runId ||
          result.status !== "answered" ||
          result.revision !== input.revision + 1 ||
          result.answer !== input.answer ||
          response?.dataEpoch !== input.dataEpoch
        )
          throw new Error("回答回执与原提交不一致，原记录仍保留。")
      }
      if (!current()) return
      if (!botUserFormPending.acknowledge(input)) {
        if (live()) setError("回答已确认，本机记录尚未清除。重试只核对原提交。")
        return
      }
      if (live()) {
        setRetired(true)
        await config.current.refresh()
      }
    } catch (failure) {
      if (live()) {
        setRecord(botUserFormPending.inspect(item.id, card.dataEpoch))
        if ((failure as { code?: string })?.code === "data_epoch") setRetired(true)
        setError(failure instanceof Error ? failure.message : "回答尚未确认，请核对原提交。")
      }
    } finally {
      owner.current.saving = false
      if (owner.current.mounted && owner.current.generation === generation) setBusy(false)
    }
  }
  const reconcile = async () => {
    if (!owner.current.mounted || !current() || owner.current.saving) return
    const generation = owner.current.generation,
      live = () => owner.current.mounted && owner.current.generation === generation && current()
    owner.current.saving = true
    setBusy(true)
    setError(null)
    try {
      const removed = await botUserFormPending.reconcile(card.dataEpoch, read, live)
      if (!live()) return
      const after = botUserFormPending.inspect(item.id, card.dataEpoch)
      setRecord(after)
      if (record.kind === "valid" && after.kind === "empty") setRetired(true)
      setError(
        removed ? "已核对本机记录。仍未确认的提交会继续保留。" : "原提交仍未确认，记录已保留。"
      )
      if (live()) await config.current.refresh()
    } catch (failure) {
      if (live()) setError(failure instanceof Error ? failure.message : "本机记录核对失败。")
    } finally {
      owner.current.saving = false
      if (owner.current.mounted && owner.current.generation === generation) setBusy(false)
    }
  }
  const filled = card.input.fields.filter((field) => (values[field.id] ?? "").trim()).length
  return (
    <section
      className="overflow-hidden rounded-xl border bg-background/80 shadow-sm"
      aria-labelledby={titleId}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <MessageSquareText className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="break-words text-sm font-semibold">
            {card.input.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {filled}/{card.input.fields.length} 已填写
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          aria-label={collapsed ? "展开表单" : "折叠表单"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </Button>
      </div>
      {!collapsed && (
        <form
          noValidate
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {card.input.description && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
              {card.input.description}
            </p>
          )}
          <fieldset disabled={disabled} className="space-y-4">
            {card.input.fields.map((field) => {
              const controlId = `${fieldPrefix}-${field.id}`,
                errorId = `${controlId}-error`,
                value = values[field.id] ?? "",
                fieldError = attempted ? errors[field.id] : null,
                update = (next: string) => setValues((old) => ({ ...old, [field.id]: next }))
              const aria = {
                id: controlId,
                "aria-required": field.required === true,
                "aria-invalid": Boolean(fieldError),
                "aria-describedby": fieldError ? errorId : undefined
              }
              return (
                <div key={field.id} className="space-y-1.5">
                  <label
                    htmlFor={controlId}
                    className="flex items-center gap-2 text-sm font-medium"
                  >
                    <span className="break-words">{field.label}</span>
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      {field.required ? "必填" : "选填"}
                    </span>
                  </label>
                  {field.type === "select" ? (
                    <Select value={value} disabled={disabled} onValueChange={update}>
                      <SelectTrigger {...aria}>
                        <SelectValue placeholder={field.placeholder ?? "请选择"} />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options?.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : field.type === "textarea" ? (
                    <textarea
                      {...aria}
                      rows={3}
                      maxLength={2000}
                      autoComplete="off"
                      value={value}
                      placeholder={field.placeholder}
                      onChange={(event) => update(event.target.value)}
                      className="min-h-24 w-full resize-y rounded-sm border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  ) : (
                    <Input
                      {...aria}
                      type={field.type === "date" ? "date" : field.type === "tel" ? "tel" : "text"}
                      inputMode={
                        field.type === "number"
                          ? "decimal"
                          : field.type === "email"
                            ? "email"
                            : undefined
                      }
                      autoComplete="off"
                      maxLength={2000}
                      value={value}
                      placeholder={field.placeholder}
                      onChange={(event) => update(event.target.value)}
                    />
                  )}
                  {field.type === "select" && !field.required && value && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-0 text-xs text-muted-foreground"
                      disabled={disabled}
                      onClick={() => update("")}
                    >
                      清除选择
                    </Button>
                  )}
                  {fieldError && (
                    <p id={errorId} role="alert" className="text-xs text-destructive">
                      {fieldError}
                    </p>
                  )}
                </div>
              )
            })}
          </fieldset>
          {restored && (
            <p role="status" className="text-sm text-muted-foreground">
              原请求已结束或工作区发生变化，请核对当前任务。
            </p>
          )}
          {!supported && (
            <p role="status" className="text-sm text-muted-foreground">
              请更新并重启 Bot 后台后填写表单。
            </p>
          )}
          {pending && (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              {Date.now() - pending.storedAt > 86_400_000
                ? "原提交超过24小时，"
                : "原回答已保存在本机，"}
              请核对原提交；不会自动改值或再次填写。
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void submit(true)}
            >
              取消填写
            </Button>
            <div className="flex items-center gap-2">
              {(error || blocked) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || restored || !supported}
                  onClick={() => void reconcile()}
                >
                  核对本机提交
                </Button>
              )}
              <Button type="submit" size="sm" disabled={busy || restored || !supported || blocked}>
                {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                {busy ? "正在确认…" : pending ? "确认原提交" : "提交"}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            回答会发给 Bot；密码和验证码请使用安全输入或人工接管。
          </p>
        </form>
      )}
    </section>
  )
}
