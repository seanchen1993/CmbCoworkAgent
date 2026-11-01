import { useRef, useState } from "react"
import type {
  LocalProjectCommand,
  LocalProjectView
} from "../../../../shared/project-runtime/platform-api"
import { ProjectFunctionConsent } from "./ProjectFunctionConsent"
import { Button } from "@/components/ui/button"
import type { HarnessNativeFeatureBinding } from "../../../../shared/harness-board-types"

const continuationLabels: Record<string, string> = {
  approval_required: "等待执行确认",
  result_approval_required: "等待成果确认",
  result_rejected: "成果已拒绝，可补充说明后重试",
  cancelled: "已停止",
  failed: "当前步骤未完成，请查看执行记录",
  unknown: "执行结果待核对",
  busy: "已有执行正在处理",
  budget: "本轮连续执行已达限额，可继续运行",
  blocked: "请核对当前配置和输入"
}

export function NativeFeatureReview(props: {
  projectId: string
  featureId: string
  binding: HarnessNativeFeatureBinding
  view?: LocalProjectView
  onRefresh(): void | Promise<void>
  onReady(ready: boolean): void
  onPendingChange(pending: boolean): void
  continuation?: LocalProjectView["continuation"]
  onContinuation(value: LocalProjectView["continuation"]): void
  onViewThread(threadId: string): void
}) {
  const continuation = props.continuation ?? props.view?.continuation
  return (
    <section className="space-y-3 rounded border p-3" aria-label="需求权限与确认">
      <p className="break-all text-xs text-muted-foreground">
        本条需求的实际运行与产物目录：{props.binding.workspace}
      </p>
      <ProjectFunctionConsent
        key={
          props.view?.operations
            .map((operation) => `${operation.operationId}:${operation.status}`)
            .join("|") ?? "pending"
        }
        projectId={props.binding.hostRunId}
        version={props.view?.project.version ?? 0}
        api={window.api.harnessBoard.nativeFeatureMods}
        onReady={props.onReady}
      />
      {continuation && continuation.reason !== "completed" && (
        <p role="status" className="text-sm">
          执行已暂停：
          {continuation.error || continuationLabels[continuation.reason] || continuation.reason}
        </p>
      )}
      {props.view && <NativeRunReview {...props} view={props.view} />}
    </section>
  )
}

/** Existing feature page accessory: approvals only, never a second project/run page. */
function NativeRunReview({
  projectId,
  featureId,
  view,
  onRefresh,
  onPendingChange,
  onContinuation,
  onViewThread
}: {
  projectId: string
  featureId: string
  view: LocalProjectView
  onRefresh(): void | Promise<void>
  onPendingChange(pending: boolean): void
  onContinuation(value: LocalProjectView["continuation"]): void
  onViewThread(threadId: string): void
}) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [consent, setConsent] = useState("")
  const stage = view.project.manifest.stages[view.project.stageIndex]
  const operation = view.operations.find(
    (item) =>
      item.stageId === stage?.id &&
      item.expectedVersion === view.project.version &&
      item.status !== "transitioned"
  )
  async function act(commands: LocalProjectCommand[]) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    onPendingChange(true)
    onContinuation(undefined)
    setError("")
    try {
      for (const command of commands) {
        const result = await window.api.harnessBoard.nativeFeatureCommand(
          projectId,
          featureId,
          command
        )
        onContinuation(result.continuation)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      try {
        await onRefresh()
      } finally {
        pending.current = false
        setBusy(false)
        onPendingChange(false)
      }
    }
  }
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {view.resultReviewError && <p role="alert">{view.resultReviewError}</p>}
      {view.inputWait && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onViewThread(view.inputWait!.threadId)}>
            查看待答复的会话
          </Button>
          {view.inputWait.resumable && (
            <Button
              disabled={busy}
              onClick={() =>
                void act([
                  {
                    kind: "resume-input",
                    operationId: view.inputWait!.operationId,
                    requestId: view.inputWait!.requestId
                  }
                ])
              }
            >
              继续执行
            </Button>
          )}
        </div>
      )}
      {operation?.status === "prepared" &&
        !operation.approval &&
        (stage?.approval === "human" || operation.contextProvider) && (
          <div className="space-y-2">
            <p>执行“{stage.title}”前需要确认。</p>
            {operation.contextProvider && (
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={consent === operation.operationId}
                  onChange={(event) =>
                    setConsent(event.target.checked ? operation.operationId : "")
                  }
                />
                {operation.contextProvider.notice}
              </label>
            )}
            <Button
              disabled={busy || (!!operation.contextProvider && consent !== operation.operationId)}
              onClick={() =>
                void act([
                  {
                    kind: "approve",
                    operationId: operation.operationId,
                    expectedVersion: operation.expectedVersion,
                    inputFingerprint: operation.inputFingerprint,
                    decision: "approved",
                    ...(operation.contextProvider
                      ? {
                          contextProviderApproval: {
                            policyDigest: operation.contextProvider.policyDigest,
                            allowNetworkSideEffects: true
                          }
                        }
                      : {})
                  },
                  { kind: "continue", expectedVersion: view.project.version }
                ])
              }
            >
              批准并执行
            </Button>
          </div>
        )}
      {operation?.status === "succeeded" &&
        (view.resultApprovalRequired ?? stage?.resultApproval === "human") &&
        !operation.resultApproval && (
          <div className="space-y-2" aria-label="成果确认">
            <p>“{stage.title}”检查通过，请查看当前节点的产物后确认成果。</p>
            <textarea
              aria-label="成果修改意见"
              value={feedback}
              maxLength={4000}
              onChange={(event) => setFeedback(event.target.value)}
              className="w-full rounded border p-2"
              placeholder="需要修改时填写意见"
            />
            <div className="flex gap-2">
              <Button
                disabled={busy || !view.resultReview}
                onClick={() =>
                  void act([
                    {
                      kind: "approve-result",
                      operationId: operation.operationId,
                      review: view.resultReview!,
                      decision: "approved"
                    },
                    { kind: "continue", expectedVersion: view.project.version }
                  ])
                }
              >
                接受成果并继续
              </Button>
              <Button
                variant="outline"
                disabled={busy || !view.resultReview}
                onClick={() =>
                  void act([
                    {
                      kind: "approve-result",
                      operationId: operation.operationId,
                      review: view.resultReview!,
                      decision: "rejected",
                      ...(feedback.trim() ? { feedback: feedback.trim() } : {})
                    }
                  ])
                }
              >
                拒绝当前成果
              </Button>
            </div>
          </div>
        )}
      {operation &&
        (["failed", "cancelled"].includes(operation.status) ||
          operation.resultApproval?.decision === "rejected") && (
          <div className="space-y-2">
            <p role="status">本次执行未完成；重试会保留原记录，重新检查输入和权限。</p>
            <textarea
              aria-label="重试补充说明"
              value={feedback}
              maxLength={4000}
              onChange={(event) => setFeedback(event.target.value)}
              className="w-full rounded border p-2"
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act([
                  ...(operation.resultApproval?.decision === "rejected"
                    ? [{ kind: "cancel" as const, operationId: operation.operationId }]
                    : []),
                  {
                    kind: "prepare",
                    expectedVersion: view.project.version,
                    idempotencyKey: `feature-retry:${crypto.randomUUID()}`,
                    stageInstructions:
                      feedback.trim() || operation.resultApproval?.feedback || undefined
                  },
                  { kind: "continue", expectedVersion: view.project.version }
                ])
              }
            >
              重新执行当前步骤
            </Button>
          </div>
        )}
      {operation?.status === "unknown" && (
        <div className="space-y-2">
          <p role="alert">上次执行结果待核对，不能直接重跑或推进。</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act([
                {
                  kind: "reconcile",
                  operationId: operation.operationId
                }
              ])
            }
          >
            核对执行结果
          </Button>
        </div>
      )}
    </div>
  )
}
