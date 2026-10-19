import type { BuiltinInstructionsReadResult } from "../../../../shared/mods/builtin-instructions"
import { HelpHint } from "../ui/help-hint"

const deliveryNames = {
  injected: "已加入本次上下文",
  truncated: "仅加入部分内容",
  omitted: "本次未加入",
  unknown: "加载情况待核对"
}

export function BuiltinInstructionsView({
  value,
  open
}: {
  value: BuiltinInstructionsReadResult
  open?: boolean
}) {
  const snapshot = value.snapshot
  const entries = snapshot?.entries ?? []
  const requests = snapshot?.finalRequests ?? []
  const changed = requests.some((item) => item.result === "modified")
  const unconfirmed = !requests.length || requests.some((item) => item.result === "unknown")
  return (
    <details data-builtin-target="instructions" open={open || undefined}>
      <summary className="cursor-pointer font-medium">项目规范 · 本次来源</summary>
      <div className="mt-2 space-y-3 rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">
            {snapshot?.origin === "disabled"
              ? "本次未开启规范加载"
              : entries.length
                ? `本次记录 ${entries.length} 个来源`
                : "尚未记录规范来源"}
          </p>
          <HelpHint label="如何理解规范记录">
            <p>这里记录应用准备任务时读取的规范来源，不表示模型已经执行这些规范。</p>
            <p>
              列表按加载顺序展示。顺序不决定冲突时谁优先；发现内容矛盾时，需要按项目规则核对原文件。
            </p>
            <p>没有来源记录不代表项目没有规范。这里只显示已保存的记录，不会重新扫描文件。</p>
            <details>
              <summary className="cursor-pointer">记录详情</summary>
              <p className="mt-2 break-words">{value.message}</p>
              {snapshot?.limitations.map((text, index) => (
                <p key={index}>{text}</p>
              ))}
            </details>
          </HelpHint>
        </div>
        {!!entries.length && (
          <>
            <p className="text-muted-foreground">内容冲突需人工核对。</p>
            <ul className="space-y-2">
              {entries.map((entry, index) => (
                <li
                  key={`${entry.path}:${index}`}
                  className="space-y-1 rounded-md bg-muted/30 p-2 leading-5"
                >
                  <p className="break-all font-medium">{entry.path}</p>
                  <p>{deliveryNames[entry.delivery]}</p>
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer">来源详情</summary>
                    <p>
                      {entry.layer === "user"
                        ? "用户规范"
                        : entry.layer === "local"
                          ? "本地补充"
                          : entry.layer === "plugin"
                            ? "项目插件"
                            : "项目规范"}
                    </p>
                    <p className="break-all">范围：{entry.scope}</p>
                    <p className="break-words">{entry.reason}</p>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
        {(!!entries.length || !!requests.length) && (
          <div className="flex items-start justify-between gap-2 border-t pt-2">
            <div className="space-y-1">
              {changed && (
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  发送内容有变化，需核对。
                </p>
              )}
              {unconfirmed && <p className="text-muted-foreground">发送情况待核对。</p>}
              {!changed && !unconfirmed && <p>已记录发送前检查。</p>}
            </div>
            <HelpHint label="规范发送情况说明">
              <p>
                加载记录和发送前检查是两件事。后续处理可能改变提示内容；即使检查通过，也不能说明模型已经遵守规范。
              </p>
            </HelpHint>
          </div>
        )}
        {!!requests.length && (
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">查看发送前检查记录</summary>
            <ul className="mt-2 space-y-1">
              {requests.map((item) => (
                <li key={item.requestId} className="break-words">
                  {new Date(item.observedAt).toLocaleTimeString()} · {item.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
  )
}
