import { useEffect, useState } from "react"
import {
  projectRangeBounds,
  projectDateMillis,
  formatProjectDate
} from "../../../../../shared/project-metric-calendar"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  type PersonalEfficiencyFilters,
  type PersonalEfficiencyPerson
} from "../../../../../shared/personal-efficiency"

import { formatPersonalMetric } from "./personal-efficiency-format"

export function PersonalEfficiencyDetail({
  person,
  filters,
  onClose
}: {
  person: PersonalEfficiencyPerson | null
  filters: PersonalEfficiencyFilters
  onClose: () => void
}): React.JSX.Element {
  const [retry, setRetry] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    sapId: string
    filters: PersonalEfficiencyFilters
    retry: number
    detail: PersonalEfficiencyPerson | null
    warnings: string[]
    error: string | null
  } | null>(null)
  const sapId = person?.sapId
  const current =
    result?.sapId === sapId && result?.filters === filters && result?.retry === retry
      ? result
      : null
  const detail = current?.detail ?? null
  const loading = Boolean(sapId && !current)
  const error = current?.error
  const warnings = current?.warnings ?? []
  const bounds = projectRangeBounds(filters.range)
  useEffect(() => {
    let active = true
    if (!sapId) return
    void window.api.dashboard
      .personalEfficiency(filters, sapId)
      .then((response) => {
        if (!active) return
        if (!response.success || !response.data)
          throw new Error(response.error || "获取个人详情失败")
        const found = response.data.people[0]
        if (!found) throw new Error("当前范围内已无该人员数据，请刷新列表")
        setResult({
          sapId,
          filters,
          retry,
          detail: found,
          warnings: response.data.warnings,
          error: null
        })
      })
      .catch((cause: unknown) => {
        if (active)
          setResult({
            sapId,
            filters,
            retry,
            detail: null,
            warnings: [],
            error: cause instanceof Error ? cause.message : String(cause)
          })
      })
    return () => {
      active = false
    }
  }, [sapId, filters, retry])
  async function exportDetail(): Promise<void> {
    if (!detail) return
    setExporting(true)
    setExportError(null)
    try {
      const response = await window.api.dashboard.personalEfficiencyExport(filters, {
        sapId: detail.sapId
      })
      if (!response.success && !response.canceled)
        throw new Error(response.error || "导出个人项目明细失败")
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }
  return (
    <Dialog
      open={Boolean(person)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-[min(1200px,95vw)] flex-col">
        <DialogHeader>
          <DialogTitle>{person?.userName} · 个人使用详情</DialogTitle>
          <DialogDescription>
            {person?.sapId} · {bounds.gte.slice(0, 10)} 至{" "}
            {formatProjectDate(projectDateMillis(bounds.lt)! - 1).slice(0, 10)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!detail || exporting}
            onClick={() => void exportDetail()}
          >
            {exporting ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 size-3.5" />
            )}
            导出明细
          </Button>
        </div>
        {exportError ? (
          <p role="alert" className="text-xs text-destructive">
            {exportError}
          </p>
        ) : null}
        <div className="space-y-5 overflow-auto text-xs">
          {loading ? (
            <div className="flex items-center gap-2 py-8">
              <Loader2 className="size-4 animate-spin" />
              加载个人详情
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-destructive">
              {error}
              <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
                重试
              </Button>
            </div>
          ) : null}
          {warnings.map((warning) => (
            <p key={warning} role="status" className="text-muted-foreground">
              {warning}
            </p>
          ))}
          {detail ? (
            <>
              <div>
                <h3 className="mb-2 font-semibold">作为项目经理的项目明细</h3>
                <div className="overflow-auto">
                  <table className="w-full whitespace-nowrap text-left">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        {[
                          "项目",
                          "所属室",
                          "关联特性",
                          "功能点",
                          "缺陷数",
                          "缺陷密度",
                          "非功能问题数",
                          "特性最早审批",
                          "开发完成",
                          "特性审批完成到开发完成耗时"
                        ].map((label) => (
                          <th key={label} className="p-2 font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.projects.map((project) => (
                        <tr key={project.prjCode} className="border-b border-border/60">
                          <td className="p-2">
                            <div>{project.prjName}</div>
                            <div className="text-muted-foreground">{project.prjCode}</div>
                          </td>
                          <td className="p-2">{project.roomName || "—"}</td>
                          <td className="p-2">
                            {project.features.map((feature) => (
                              <div key={feature.featureCode}>
                                {feature.featureCode} {feature.featureName}
                              </div>
                            ))}
                          </td>
                          <td className="p-2 tabular-nums">
                            {formatPersonalMetric(project.notAdjustFuns)}
                          </td>
                          <td className="p-2 tabular-nums">
                            {formatPersonalMetric(project.bugNum)}
                          </td>
                          <td className="p-2 tabular-nums">
                            {formatPersonalMetric(project.defectDensityPer100Fp)}
                          </td>
                          <td
                            className="p-2 tabular-nums"
                            title={project.kenanIssueCategories
                              .map((c) => `${c.category}：${c.count}`)
                              .join("；")}
                          >
                            {formatPersonalMetric(project.kenanIssueCount)}
                          </td>
                          <td className="p-2">{project.approvedDate || "—"}</td>
                          <td className="p-2">
                            {project.firstStStartDate || project.firstUatStartDate || "—"}
                          </td>
                          <td className="p-2 tabular-nums">
                            {formatPersonalMetric(project.approvalDevelopmentDays)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!detail.projects.length ? (
                    <p className="p-4 text-muted-foreground">当前范围内无负责项目</p>
                  ) : null}
                </div>
              </div>
              <div>
                <h3 className="mb-2 font-semibold">项目模式代码明细</h3>
                <table className="w-full text-left">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      {[
                        "项目编号",
                        "代码所属室",
                        "已 Push 采纳行数",
                        "对应有效生成行数",
                        "AI代码入库率"
                      ].map((label) => (
                        <th key={label} className="p-2 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.code.map((code) => (
                      <tr
                        key={`${code.harnessProjectId}:${code.roomName}`}
                        className="border-b border-border/60"
                      >
                        <td className="p-2">{code.prjCode}</td>
                        <td className="p-2">{code.roomName || "—"}</td>
                        <td className="p-2 tabular-nums">
                          {formatPersonalMetric(code.pushedAdoptedLines)}
                        </td>
                        <td className="p-2 tabular-nums">
                          {formatPersonalMetric(code.pushedEffectiveGeneratedLines)}
                        </td>
                        <td className="p-2 tabular-nums">
                          {formatPersonalMetric(
                            code.pushedEffectiveGeneratedLines > 0
                              ? (code.pushedAdoptedLines * 100) / code.pushedEffectiveGeneratedLines
                              : null,
                            "%"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!detail.code.length ? (
                  <p className="p-4 text-muted-foreground">当前范围内无个人精益项目代码记录</p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
