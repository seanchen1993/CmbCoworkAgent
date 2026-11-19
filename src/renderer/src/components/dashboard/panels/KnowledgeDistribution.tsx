import { useCallback, useMemo, useState, type ReactNode } from "react"
import { ChevronRight, Loader2 } from "lucide-react"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltip } from "recharts"
import {
  normalizeRoomName,
  type KnowledgeDistributionItem,
  type KnowledgeOrgItem,
  type KnowledgeRoom
} from "../../../../../shared/dashboard-knowledge-overview"
import { useKnowledgeDetails, type KnowledgePeopleState } from "../use-knowledge-details"

const COLORS = ["#3b82f6", "#14b8a6", "#8b5cf6", "#f59e0b", "#f97316", "#94a3b8"]
const distributionColor = (index: number): string =>
  COLORS[index] ?? `hsl(${(index * 137.508) % 360} 65% 50%)`
const number = (value: number): string => value.toLocaleString("zh-CN")

export function Status({
  loading,
  error,
  empty
}: {
  loading: boolean
  error?: string | null
  empty?: boolean
}): React.JSX.Element | null {
  if (loading)
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载中
      </div>
    )
  if (error)
    return (
      <div
        role="alert"
        className="flex h-40 items-center justify-center px-4 text-xs text-destructive"
      >
        {error}
      </div>
    )
  if (empty)
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
        暂无数据
      </div>
    )
  return null
}

interface DistributionProps<T extends KnowledgeDistributionItem> {
  title: string
  items: T[] | null
  loading: boolean
  error?: string | null
  trail?: ReactNode
  action?: (row: T) => (() => void) | undefined
  retry?: () => void
}

const cardClass =
  "flex h-[clamp(240px,38vh,320px)] min-w-0 flex-col rounded-xl border border-border bg-card p-4"

export function Distribution<T extends KnowledgeDistributionItem>({
  title,
  items,
  loading,
  error,
  trail,
  action,
  retry
}: DistributionProps<T>): React.JSX.Element {
  const rows = items ?? []
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  return (
    <section aria-label={title} className={cardClass}>
      <div className="text-xs font-medium">{title}</div>
      {trail}
      {loading || error || total === 0 ? (
        <>
          <Status loading={loading} error={error} empty={total === 0} />
          {error && retry && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={retry}>
              重试
            </button>
          )}
        </>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 items-center gap-3">
          <div className="relative h-44 w-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={rows}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={49}
                  outerRadius={70}
                  stroke="none"
                  onClick={
                    action
                      ? (_, index) => {
                          const row = rows[index]
                          if (row) action(row)?.()
                        }
                      : undefined
                  }
                >
                  {rows.map((row, index) => (
                    <Cell
                      key={`${row.name}-${index}`}
                      fill={distributionColor(index)}
                      cursor={action?.(row) ? "pointer" : undefined}
                    />
                  ))}
                </Pie>
                <ChartTooltip
                  formatter={(value, name) => [
                    typeof value === "number" ? number(value) : "—",
                    name ?? "未归属"
                  ]}
                  contentStyle={{ maxWidth: 280, whiteSpace: "normal", overflowWrap: "anywhere" }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-base font-semibold">{number(total)}</span>
              <span className="text-[10px] text-muted-foreground">总数</span>
            </div>
          </div>
          <div
            className="max-h-full min-h-0 min-w-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain py-1 pr-2"
            tabIndex={0}
            role="region"
            aria-label={`${title}图例，共 ${rows.length} 类`}
          >
            {rows.map((row, index) => {
              const select = action?.(row)
              const Row = select ? "button" : "div"
              return (
                <Row
                  key={`${row.name}-${index}`}
                  type={select ? "button" : undefined}
                  onClick={select}
                  aria-label={select ? `查看${row.name}` : undefined}
                  className={`flex w-full items-center gap-1.5 rounded-sm text-left text-[10px] ${select ? "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" : ""}`}
                >
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: distributionColor(index) }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={row.name}>
                    {row.name}
                  </span>
                  <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
                    {number(row.value)}
                  </span>
                  <span className="w-10 shrink-0 text-right text-muted-foreground">
                    {((row.value / total) * 100).toFixed(1)}%
                  </span>
                  {action && (
                    <ChevronRight
                      aria-hidden
                      className={`size-3 shrink-0 text-muted-foreground ${select ? "" : "invisible"}`}
                    />
                  )}
                </Row>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

type OrgProps = Pick<
  DistributionProps<KnowledgeOrgItem>,
  "items" | "loading" | "error" | "retry"
> & {
  rooms: string[]
  initialRoom?: KnowledgeRoom
  people: KnowledgePeopleState
}

const title = "部门分布情况"

export function KnowledgeOrgDistribution(props: OrgProps): React.JSX.Element {
  const [selected, setSelected] = useState<KnowledgeRoom | null>(null)
  const room = props.initialRoom ?? selected
  return room ? (
    <RoomDistribution
      key={room.id}
      {...props}
      room={room}
      returnToRooms={props.initialRoom ? undefined : () => setSelected(null)}
    />
  ) : (
    <Distribution
      {...props}
      title={title}
      action={({ id, name }) => (id ? () => setSelected({ id, name }) : undefined)}
    />
  )
}

function RoomDistribution({
  room,
  rooms,
  initialRoom,
  items,
  loading,
  error,
  retry,
  people,
  returnToRooms
}: OrgProps & { room: KnowledgeRoom; returnToRooms?: () => void }): React.JSX.Element {
  const [group, setGroup] = useState<KnowledgeOrgItem | null>(null)
  const load = useCallback(
    (scope: string[]) => window.api.dashboard.knowledgeOrgGroups(room.id, { upperOrgLv1: scope }),
    [room.id]
  )
  const groups = useKnowledgeDetails(!initialRoom, rooms, "dashboard:knowledgeOrgGroups", load)
  const members = useMemo(() => {
    if (!group) return []
    return (people.data?.items ?? [])
      .filter((row) => {
        const sameRoom = row.roomId
          ? row.roomId === room.id
          : row.roomName
            ? normalizeRoomName(row.roomName) === normalizeRoomName(room.name)
            : !!initialRoom
        if (!sameRoom) return false
        if (group.id != null) return row.groupId === group.id
        return !row.groupId && !row.groupName && (row.groupId === null || row.groupName === null)
      })
      .sort(
        (a, b) =>
          b.totalNum - a.totalNum ||
          a.userName.localeCompare(b.userName, "zh-CN", { numeric: true })
      )
  }, [people.data, room, initialRoom, group])
  const crumbClass =
    "min-w-0 truncate text-left text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
  const trail = (
    <nav
      aria-label="部门分布路径"
      className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
    >
      {returnToRooms && (
        <>
          <button type="button" onClick={returnToRooms} className={crumbClass}>
            室分布
          </button>
          <ChevronRight className="size-3 shrink-0" />
        </>
      )}
      {group ? (
        <>
          <button
            type="button"
            onClick={() => setGroup(null)}
            className={crumbClass}
            title={room.name}
          >
            {room.name}
          </button>
          <ChevronRight className="size-3 shrink-0" />
          <span className="truncate" aria-current="page" title={group.name}>
            {group.name}
          </span>
        </>
      ) : (
        <span className="truncate" aria-current="page" title={room.name}>
          {room.name}
        </span>
      )}
    </nav>
  )
  if (!group) {
    return (
      <Distribution
        title={title}
        trail={trail}
        items={initialRoom ? items : groups.data}
        loading={initialRoom ? loading : groups.loading}
        error={initialRoom ? error : groups.error}
        retry={initialRoom ? retry : groups.retry}
        action={(row) =>
          row.id || (row.id === null && row.name === "未归属组") ? () => setGroup(row) : undefined
        }
      />
    )
  }
  const memberError =
    people.error ?? (people.data?.unavailableReason ? "当前范围无法查看人员明细" : null)
  return (
    <section aria-label={title} className={cardClass}>
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        {title}
        <span className="text-[10px] font-normal text-muted-foreground">知识沉淀总数</span>
      </div>
      {trail}
      {people.loading || memberError ? (
        <>
          <Status loading={people.loading} error={memberError} />
          {people.error && (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={people.retry}
            >
              重试
            </button>
          )}
        </>
      ) : members.length ? (
        <ol
          aria-label="组内人员排名"
          className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain text-[11px]"
        >
          {members.map((row, i) => (
            <li
              key={i}
              className="flex items-center gap-2 border-b border-border/50 py-2 last:border-0"
            >
              <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={row.userName}>
                {row.userName || "未记录姓名"}
              </span>
              <span className="font-medium tabular-nums">{number(row.totalNum)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          暂无组内人员明细
        </div>
      )}
    </section>
  )
}
