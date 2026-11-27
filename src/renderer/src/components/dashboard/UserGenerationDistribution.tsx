import { useEffect, useState } from "react"
import type { UserGenerationSplit } from "../../../../shared/chat-project"

const number = (value: number) => value.toLocaleString("zh-CN")
const percent = (value: number, total: number) =>
  total
    ? (value / total).toLocaleString("zh-CN", { style: "percent", maximumFractionDigits: 1 })
    : "—"

function ProjectLines({
  title,
  projects
}: {
  title: string
  projects: UserGenerationSplit["projects"]
}) {
  const [limit, setLimit] = useState(20)
  const sum = projects.reduce((n, p) => n + p.lines, 0)
  if (!projects.length) return <div>{title} · 0 行</div>
  return (
    <details>
      <summary className="cursor-pointer">
        {title} · {number(sum)} 行
      </summary>
      <ul className="ml-4 mt-1 space-y-1">
        {projects.slice(0, limit).map((p) => (
          <li className="flex justify-between" key={p.code}>
            <span>{p.code || "其他权限范围"}</span>
            <span>{number(p.lines)} 行</span>
          </li>
        ))}
      </ul>
      {projects.length > limit && (
        <button className="ml-4 text-primary" onClick={() => setLimit(limit + 20)}>
          显示更多项目
        </button>
      )}
    </details>
  )
}

export function UserGenerationDistribution({
  sapId,
  from,
  to
}: {
  sapId: string
  from: string
  to: string
}) {
  const [data, setData] = useState<UserGenerationSplit | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setData(null)
    setError("")
    window.api.dashboard
      .userGenerationSplit(sapId, { from, to })
      .then((result) => {
        if (!current) return
        if (result.success && result.data) setData(result.data)
        else setError(result.error || "生成行数分布暂不可用")
      })
      .catch((e) => {
        if (current) setError(String(e))
      })
    return () => {
      current = false
      void window.api.dashboard.cancelRequests(["dashboard:userGenerationSplit"]).catch(() => {})
    }
  }, [sapId, from, to, attempt])
  const bound = data?.projects.reduce((n, p) => n + p.lines, 0) ?? 0
  const chat = bound + (data?.unbound ?? 0)
  const total = chat + (data?.project ?? 0) + (data?.unknown ?? 0)
  return (
    <section className="mt-4 space-y-2 border-t pt-3 text-xs">
      <h4 className="font-semibold">生成行数分布</h4>
      {error ? (
        <div role="alert">
          {error}{" "}
          <button className="text-primary" onClick={() => setAttempt(attempt + 1)}>
            重试
          </button>
        </div>
      ) : !data ? (
        <div className="text-muted-foreground">正在统计…</div>
      ) : (
        <>
          <table className="w-full text-left tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th>生成来源</th>
                <th className="text-right">生成行数</th>
                <th className="text-right">占总生成</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["项目模式", data.project],
                  ["对话模式", chat],
                  ...(data.unknown ? [["无法判定", data.unknown]] : [])
                ] as [string, number][]
              ).map(([label, count]) => (
                <tr key={label}>
                  <td className="py-1">{label}</td>
                  <td className="text-right">{number(count)}</td>
                  <td className="text-right">{percent(count, total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary className="cursor-pointer">
              对话模式中已关联项目 {number(bound)} 行，占对话模式 {percent(bound, chat)}
            </summary>
            <div className="ml-4 mt-2 space-y-2">
              <ProjectLines
                title="已关联精益项目"
                projects={data.projects.filter((p) => p.fromLean)}
              />
              <ProjectLines
                title="已指定自定义项目"
                projects={data.projects.filter((p) => !p.fromLean)}
              />
              <div>未关联项目 · {number(data.unbound)} 行</div>
            </div>
          </details>
        </>
      )}
    </section>
  )
}
