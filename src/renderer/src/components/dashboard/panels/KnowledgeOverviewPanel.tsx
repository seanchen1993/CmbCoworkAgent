import { useState, type ComponentType, type ReactNode } from "react"
import {
  BookOpen,
  Filter,
  ChevronRight,
  Download,
  Eye,
  FileText,
  FolderKanban,
  Trash2,
  Wrench,
  Zap
} from "lucide-react"
import type {
  KnowledgeAccumulationData,
  KnowledgeProjectStats,
  KnowledgeRecentConstraintFiles
} from "../../../../../shared/dashboard-knowledge-overview"
import type {
  DashboardKnowledgeCommitRate,
  DashboardKnowledgeCommitRateUnavailableReason
} from "../../../../../shared/dashboard-knowledge-commit-rate"
import { Button } from "@/components/ui/button"
import { InfoHint } from "./dashboard-shared"
import { KnowledgeActiveDetailsDialog } from "../KnowledgeActiveDetailsDialog"
import { Distribution, KnowledgeOrgDistribution, Status } from "./KnowledgeDistribution"
import { useKnowledgePeople } from "../use-knowledge-details"
import { KnowledgeUserDetailsTable } from "../KnowledgeUserDetailsTable"

const SCOPE_NOTES: Record<DashboardKnowledgeCommitRateUnavailableReason, string> = {
  multipleRooms: "多选室时不展示",
  unclassified: "未归属没有室编号",
  roomNotMapped: "未配置室编号",
  noAccess: "仅可查看本室"
}
const number = (value: number | undefined): string =>
  value === undefined ? "—" : value.toLocaleString("zh-CN")
const percent = (value: number | null | undefined): string =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`
const ratio = (a: number | undefined, b: number | undefined): number | null =>
  a != null && b != null && b > 0 ? a / b : null

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
  hint
}: {
  label: string
  value: ReactNode
  sub?: string
  icon: ComponentType<{ className?: string }>
  color: string
  hint?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4">
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-5 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>{label}</span>
          {hint && <InfoHint content={hint} />}
        </div>
        <div className="mt-1 text-xl font-semibold leading-tight">{value}</div>
        {sub && <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

export function KnowledgeOverviewPanel({
  accumulation,
  accumulationLoading,
  accumulationError,
  retryAccumulation,
  projects,
  projectsLoading,
  projectsError,
  recentConstraintFiles,
  recentConstraintFilesLoading,
  recentConstraintFilesError,
  rate,
  rateLoading,
  rateError,
  rooms,
  refreshKey,
  createdInRangeOnly = false,
  onCreatedInRangeOnlyChange
}: {
  accumulation: KnowledgeAccumulationData | null
  accumulationLoading: boolean
  accumulationError: string | null
  retryAccumulation: () => void
  projects: KnowledgeProjectStats | null
  projectsLoading: boolean
  projectsError: string | null
  recentConstraintFiles: KnowledgeRecentConstraintFiles | null
  recentConstraintFilesLoading: boolean
  recentConstraintFilesError: string | null
  rate: DashboardKnowledgeCommitRate | null
  rateLoading: boolean
  rateError: string | null
  rooms: string[]
  refreshKey: number
  createdInRangeOnly?: boolean
  onCreatedInRangeOnlyChange?: (value: boolean) => void
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const people = useKnowledgePeople(rooms, refreshKey)
  const totals = accumulation?.totals ?? undefined
  const users = accumulation?.users?.slice(0, 20) ?? []
  const maxUser = Math.max(1, ...users.map((row) => row.value))
  const scopeNote = accumulation?.unavailableReason
    ? SCOPE_NOTES[accumulation.unavailableReason]
    : undefined
  const sectionError = (key: "totals" | "users" | "orgs" | "systems"): string | undefined =>
    accumulationError ?? scopeNote ?? accumulation?.errors[key]
  const rateNote =
    rateError ?? (rate?.unavailableReason ? SCOPE_NOTES[rate.unavailableReason] : undefined)
  const statSub = accumulationLoading ? "加载中…" : sectionError("totals")
  const readRatio = ratio(recentConstraintFiles?.fileCount, totals?.totalNum)
  const readShare = `${readRatio != null && recentConstraintFiles?.complete === false ? "≥" : ""}${percent(readRatio)}`
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            项目系统约束阅读情况
            <InfoHint
              content={
                createdInRangeOnly
                  ? "仅统计顶部所选日期内新建的项目；加载情况取这些项目的累计状态，读取项目数和次数仅统计它们在所选日期内的成功读取。加载率和读取率均以本期新建项目数为分母。"
                  : "统计当前权限和室范围内的全部项目，加载情况及成功读取数据均为累计口径，不受顶部日期筛选影响。"
              }
            />
          </div>
          <Button
            size="sm"
            variant={createdInRangeOnly ? "default" : "outline"}
            className="gap-1.5 text-xs"
            aria-pressed={createdInRangeOnly}
            onClick={() => onCreatedInRangeOnlyChange?.(!createdInRangeOnly)}
            title="仅统计所选日期内新建的项目及其本期读取数据"
          >
            <Filter className="size-3.5" />
            仅本期新建
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {createdInRangeOnly ? "仅本期新建项目 · 读取数据按所选日期统计" : "全部项目 · 累计数据"}
        </p>
        {projectsError && (
          <div role="alert" className="text-xs text-destructive">
            {projectsError}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="项目总数"
            value={number(projects?.projectCount)}
            sub={projectsLoading ? "加载中…" : "计数"}
            icon={FolderKanban}
            color="bg-blue-500"
          />
          <StatCard
            label="加载系统约束项目数"
            value={number(projects?.loadedProjectCount)}
            sub={`加载率 · ${percent(ratio(projects?.loadedProjectCount, projects?.projectCount))}`}
            icon={Download}
            color="bg-emerald-500"
            hint="至少有一次会话完整、成功加载系统约束的项目数。"
          />
          <StatCard
            label="读取系统约束项目数"
            value={number(projects?.readProjectCount)}
            sub={`读取率 · ${percent(ratio(projects?.readProjectCount, projects?.projectCount))}`}
            icon={Eye}
            color="bg-teal-500"
            hint={
              createdInRangeOnly
                ? "本期新建项目中，在所选日期内至少成功读取一次系统约束的项目数，同一项目只计一次。"
                : "历史累计至少成功读取一次系统约束的项目数，同一项目只计一次。"
            }
          />
          <StatCard
            label="读取系统约束总次数"
            value={number(projects?.successfulReadCount)}
            sub="次 · 计数"
            icon={BookOpen}
            color="bg-violet-600"
            hint={
              createdInRangeOnly
                ? "本期新建项目在所选日期内成功读取系统约束的次数。"
                : "历史累计成功读取系统约束的次数。"
            }
          />
        </div>
      </section>
      <section className="space-y-3">
        <div className="text-sm font-semibold">知识沉淀运行情况</div>
        <div className="text-[11px] text-muted-foreground">
          知识总量及分布为累计数据，活跃指标统计近30天，不受日期筛选影响；技能修改采纳率按所选日期统计。
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="生成知识沉淀数目"
            value={number(totals?.totalNum)}
            sub={statSub ?? "条 · 累计"}
            icon={FileText}
            color="bg-blue-500"
          />
          <StatCard
            label="废弃知识沉淀数目"
            value={number(totals?.abandonedNum)}
            sub={statSub ?? `废弃率 · ${percent(ratio(totals?.abandonedNum, totals?.totalNum))}`}
            icon={Trash2}
            color="bg-red-400"
          />
          <StatCard
            label="活跃知识沉淀数目"
            value={
              <button
                type="button"
                className="flex w-full items-baseline gap-4 text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="查看活跃知识沉淀明细"
                aria-haspopup="dialog"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen(true)}
              >
                <span className="whitespace-nowrap">
                  {number(totals?.activeNum)}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">更新</span>
                </span>
                <span className="whitespace-nowrap">
                  {recentConstraintFilesLoading ||
                  recentConstraintFilesError ||
                  !recentConstraintFiles
                    ? "—"
                    : `${recentConstraintFiles.complete ? "" : "≥"}${number(recentConstraintFiles.fileCount)}`}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">读取</span>
                </span>
                <ChevronRight className="ml-auto size-3.5 shrink-0 self-center text-muted-foreground" />
              </button>
            }
            sub={
              statSub ??
              (recentConstraintFilesLoading
                ? "读取加载中…"
                : (recentConstraintFilesError ??
                  `近30天 · 更新占比 ${percent(ratio(totals?.activeNum, totals?.totalNum))} · 读取占比 ${readShare}`))
            }
            icon={Zap}
            color="bg-emerald-500"
            hint={
              <div className="space-y-1">
                <p>近30天内，更新数表示有更新的知识沉淀，读取数表示被有效读取过的知识沉淀。</p>
                <p>读取数按插件和文件去重，两个指标均不受日期筛选影响。</p>
                <p>更新占比和读取占比均以生成知识沉淀总数为分母。</p>
                {recentConstraintFiles && !recentConstraintFiles.complete && (
                  <p>部分记录信息不完整，读取数显示已确认的数量。</p>
                )}
              </div>
            }
          />
          <StatCard
            label="技能修改采纳率"
            value={rateLoading || rateError ? "—" : percent(rate?.rate)}
            sub={rateLoading ? "加载中…" : rateNote}
            icon={Wrench}
            color="bg-violet-600"
            hint="AI 修改的知识库内容被用户提交的百分比。"
          />
        </div>
      </section>
      <section className="space-y-3">
        <div className="text-sm font-semibold">知识沉淀分析</div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <div className="flex h-[clamp(240px,38vh,320px)] min-w-0 flex-col rounded-xl border border-border bg-card p-4">
            <div className="flex shrink-0 items-center justify-between text-xs font-medium">
              <span>用户分析</span>
              <span className="text-[10px] font-normal text-muted-foreground">提交次数 Top 20</span>
            </div>
            {accumulationLoading || sectionError("users") || users.length === 0 ? (
              <Status
                loading={accumulationLoading}
                error={sectionError("users")}
                empty={users.length === 0}
              />
            ) : (
              <div
                className="mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-2"
                tabIndex={0}
                role="region"
                aria-label="提交次数 Top 20 用户排行"
              >
                {users.map((row, index) => (
                  <div key={row.name} className="flex items-center gap-2 text-[11px]">
                    <span className="w-5 shrink-0 tabular-nums text-amber-600">{index + 1}</span>
                    <span className="w-28 shrink-0 truncate" title={row.name}>
                      {row.name}
                    </span>
                    <div className="h-1 flex-1 rounded bg-muted">
                      <div
                        className="h-1 rounded bg-blue-400"
                        style={{ width: `${(row.value / maxUser) * 100}%` }}
                      />
                    </div>
                    <span className="w-10 text-right font-medium tabular-nums">
                      {number(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <KnowledgeOrgDistribution
            key={JSON.stringify([rooms, refreshKey])}
            rooms={rooms}
            initialRoom={accumulation?.orgRoom}
            people={people}
            retry={scopeNote ? undefined : retryAccumulation}
            items={accumulation?.orgs ?? null}
            loading={accumulationLoading}
            error={sectionError("orgs")}
          />
          <Distribution
            title="系统分布情况"
            items={accumulation?.systems ?? null}
            loading={accumulationLoading}
            error={sectionError("systems")}
          />
        </div>
      </section>
      <KnowledgeUserDetailsTable key={JSON.stringify(rooms)} people={people} />
      {detailsOpen && (
        <KnowledgeActiveDetailsDialog
          key={JSON.stringify([rooms, refreshKey])}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          rooms={rooms}
        />
      )}
    </div>
  )
}
