export function ChatTaskOverview({
  working,
  waitingApproval,
  waitingInput,
  interrupted,
  paused,
  hasReply,
  hasMessages,
  error,
  disabled,
  onReturn,
  onStop,
  onContinue
}: {
  working: boolean
  waitingApproval: boolean
  waitingInput: boolean
  interrupted: boolean
  paused?: boolean
  hasReply: boolean
  hasMessages: boolean
  error?: string | null
  disabled: boolean
  onReturn(): void
  onStop(): void
  onContinue?(): void
}) {
  const title = waitingApproval
    ? "需要你确认"
    : waitingInput
      ? "需要你补充信息"
      : working
        ? "正在处理你的任务"
        : error
          ? "这次处理没有完成"
          : paused
            ? "任务已暂停"
            : interrupted
              ? "任务已中断"
              : hasReply
                ? "已回复"
                : hasMessages
                  ? "等待继续"
                  : "直接说你想完成什么"
  const description = waitingApproval
    ? "回到聊天查看具体操作，确认后会继续。"
    : waitingInput
      ? "回到聊天回答助手的问题，就能继续处理。"
      : working
        ? "助手会使用已启用的功能处理需求，结果会显示在聊天里。"
        : error
          ? "失败信息保留在聊天中。可以补充要求后继续处理。"
          : paused
            ? "可以继续原任务，也可以先回到聊天补充要求。"
            : interrupted
              ? "查看聊天中的中断说明，再决定如何继续。"
              : hasReply
                ? "在聊天中查看回复和文件；有新的要求直接继续说。"
                : "在输入框描述需求并发送，通常不需要先选择方案或配置步骤。"
  return (
    <section aria-label="聊天任务状态" className="space-y-3 rounded-xl border p-4 text-sm">
      <p role="status" className="font-medium">
        {title}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div className="flex flex-wrap gap-2">
        {paused && onContinue && (
          <button
            type="button"
            disabled={disabled}
            className="rounded-lg border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50"
            onClick={onContinue}
          >
            继续原任务
          </button>
        )}
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-xs hover:bg-muted"
          onClick={onReturn}
        >
          {waitingApproval
            ? "去确认操作"
            : waitingInput
              ? "去回答问题"
              : hasMessages
                ? "回到聊天"
                : "描述任务"}
        </button>
        {working && (
          <button
            type="button"
            disabled={disabled}
            className="rounded-lg border px-3 py-2 text-xs text-destructive hover:bg-muted disabled:opacity-50"
            onClick={onStop}
          >
            停止本次任务
          </button>
        )}
      </div>
    </section>
  )
}
