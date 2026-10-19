import { compositionProblem } from "@/lib/project-composition-ui"

export function ProjectCompositionProblem({
  value,
  status,
  role,
  className
}: {
  value: unknown
  status?: string
  role?: "alert" | "status"
  className?: string
}) {
  const problem = compositionProblem(value, status)
  return (
    <div role={role} className={className ?? "break-words text-sm"}>
      <p>{problem.message}</p>
      {problem.nextStep && <p className="mt-1">{problem.nextStep}</p>}
      {problem.detail && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">技术详情</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">
            {problem.detail}
          </pre>
        </details>
      )}
    </div>
  )
}
