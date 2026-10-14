import type {
  BuiltinLegacyMetrics,
  BuiltinPolicyDecisionView
} from "../../../../shared/mods/builtin-policy-metrics"

export function BuiltinPolicyDecisions({ view }: { view?: BuiltinPolicyDecisionView }) {
  if (!view) return null
  return (
    <section aria-label="实际确认与限制" className="mt-3 space-y-2">
      <p className="text-muted-foreground">{view.explanation}</p>
      {!view.records.length && <p>暂无本次确认记录；这不代表没有限制。</p>}
      {view.records.map((record) => (
        <div key={record.id} className="space-y-1 rounded border p-2">
          <p>{record.explanation}</p>
          <p className="text-muted-foreground">下一步：{record.nextStep}</p>
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">时间与规则来源</summary>
            <p>
              {new Date(record.at).toLocaleString()} ·{" "}
              {
                {
                  "tool-approval": "原工具审批",
                  "tool-policy": "原工具限制",
                  hook: "原插件检查",
                  "managed-policy": "宿主组织策略",
                  publication: "输出检查"
                }[record.source]
              }
            </p>
            <p className="break-all">
              事件：{record.event}；规则：{record.ruleId}
            </p>
            {record.policyDigest && <p className="break-all">策略版本：{record.policyDigest}</p>}
          </details>
        </div>
      ))}
      {view.limited && (
        <p className="text-muted-foreground">仅保留最近 100 条，较早记录未包含在内。</p>
      )}
    </section>
  )
}

export function BuiltinOriginalProjectMetrics({ value }: { value?: BuiltinLegacyMetrics }) {
  if (!value || value.state !== "observed") return null
  return (
    <section aria-label="原项目执行记录" className="mt-3 space-y-2 rounded border p-2">
      <p className="font-medium">原项目执行情况</p>
      <p className="text-muted-foreground">已保留的原执行账本（不包含下方托管快照统计）</p>
      {!value.executions.length ? (
        <p>暂无可关联的执行账本记录；不代表项目没有执行。</p>
      ) : (
        <>
          <p>
            执行中 {value.counts.started} 次，结束 {value.counts.succeeded} 次，失败{" "}
            {value.counts.failed} 次， 停止 {value.counts.cancelled} 次，结果待核对{" "}
            {value.counts.unknown} 次。
          </p>
          <p>
            已知执行时间：
            {value.totalSettledExecutionMs === null
              ? "未知"
              : `${(value.totalSettledExecutionMs / 1000).toFixed(1)} 秒`}
            ； 同一需求后续执行 {value.repeatedExecutions} 次。
          </p>
        </>
      )}
      <p className="text-muted-foreground">{value.explanation}</p>
      {value.managedRun && (
        <div className="space-y-1">
          <p>
            原托管任务：
            {
              { running: "执行中", completed: "已结束", failed: "失败", cancelled: "已停止" }[
                value.managedRun.status
              ]
            }
            ；服务请求重试 {value.managedRun.providerRetries} 次。
          </p>
          <p>
            托管快照已知耗时：
            {value.managedRun.durationMs === null
              ? "未知"
              : `${(value.managedRun.durationMs / 1000).toFixed(1)} 秒`}
            。
          </p>
          <p className="text-muted-foreground">这是关联托管任务的单独快照，不与执行账本相加。</p>
          <p className="text-muted-foreground">
            托管结束不等于业务验收通过，请查看原项目检查结果。
          </p>
        </div>
      )}
      <p className="text-muted-foreground">人工确认等待时间、模型用量和费用：暂无可关联记录。</p>
      <details>
        <summary className="cursor-pointer text-muted-foreground">展开原运行记录</summary>
        {value.executions.map((row) => (
          <div key={row.operationId} className="mt-2 space-y-1 break-all">
            <p>
              {new Date(row.startedAt).toLocaleString()} ·{" "}
              {
                {
                  started: "执行中",
                  succeeded: "已结束",
                  failed: "失败",
                  cancelled: "已停止",
                  unknown: "需核对结果"
                }[row.status]
              }
            </p>
            <p>
              会话：{row.threadId}；记录：{row.operationId}
            </p>
          </div>
        ))}
      </details>
      {value.limited && <p className="text-muted-foreground">仅显示最近保留记录，不是全部历史。</p>}
    </section>
  )
}
