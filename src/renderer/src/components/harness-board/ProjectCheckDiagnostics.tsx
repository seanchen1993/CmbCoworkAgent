import type { HostExecutionTerminal } from "../../../../shared/project-runtime/host-types"

/** Original failed-check evidence only; it never enables ordinary chat or records success. */
export function ProjectCheckDiagnostics({ terminal }: { terminal?: HostExecutionTerminal | null }) {
  if (!terminal?.checkDiagnostics?.length) return null
  return (
    <section aria-label="本次检查失败详情" className="mt-2 space-y-2 rounded border p-2">
      {terminal.checkDiagnostics.map((check) => (
        <div key={`${check.checkId}:${check.executionId}`} className="space-y-1">
          <p className="font-medium">
            未通过 · {check.checkId} · {check.provider.plugin}
          </p>
          {check.summary && <p className="whitespace-pre-wrap break-words">{check.summary}</p>}
          {check.errors.map((error, index) => (
            <p key={`error:${index}`} className="whitespace-pre-wrap break-words">
              错误 · {error.code}：{error.message}
            </p>
          ))}
          {check.warnings.map((warning, index) => (
            <p key={`warning:${index}`} className="whitespace-pre-wrap break-words">
              提醒 · {warning.code}：{warning.message}
            </p>
          ))}
          {check.truncated && <p>诊断显示已截断，请结合本次会话和成果文件核对。</p>}
        </div>
      ))}
      <p>核对并修正上述问题后，请从本项目重新开始当前阶段。阶段会话仅供查看。</p>
    </section>
  )
}
