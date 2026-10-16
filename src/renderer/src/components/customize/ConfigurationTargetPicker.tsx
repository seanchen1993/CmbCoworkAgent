import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, Search } from "lucide-react"
import {
  chooseConfigurationTarget,
  configurationTargetValid,
  configurationWorkspace,
  supportsConfiguration,
  useConfigurationTarget,
  type ConfigurationThread
} from "@/lib/configuration-target"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const optionKey = (id: string | null, workspace: string | null) =>
  JSON.stringify([id, normalizeWorkspacePathKey(workspace)])

export function ConfigurationTargetPicker({ threads }: { threads: ConfigurationThread[] }) {
  const target = useConfigurationTarget()
  const [error, setError] = useState("")
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [highlight, setHighlight] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const available = threads.filter(supportsConfiguration)
  const valid = !!target && configurationTargetValid(target, threads)
  const selectedKey = target ? optionKey(target.threadId, target.workspace) : ""
  const selected = valid
    ? available.find((row) => optionKey(row.thread_id, configurationWorkspace(row)) === selectedKey)
    : undefined
  const query = search.trim().toLocaleLowerCase()
  const matches = available.filter((row) =>
    [row.title, configurationWorkspace(row)].join(" ").toLocaleLowerCase().includes(query)
  )
  const visible = matches.slice(0, 100)
  const highlighted = Math.min(highlight, Math.max(0, visible.length - 1))
  const empty = available.length === 0
  useEffect(() => {
    if (open)
      document.getElementById(`${id}-option-${highlighted}`)?.scrollIntoView({ block: "nearest" })
  }, [open, id, highlighted])
  const choose = (row: ConfigurationThread) => {
    setError(
      chooseConfigurationTarget({
        threadId: row.thread_id,
        workspace: configurationWorkspace(row)
      }) ?? ""
    )
    setOpen(false)
  }
  return (
    <section className="space-y-2 border-b px-4 py-3" aria-label="配置目标聊天">
      <label id={`${id}-label`} className="block text-sm font-medium">
        为哪段聊天配置
      </label>
      <Popover
        open={open && !empty}
        onOpenChange={(value) => {
          setOpen(value)
          if (value) {
            setSearch("")
            setHighlight(0)
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-label="配置目标聊天"
            aria-expanded={open && !empty}
            aria-controls={`${id}-list`}
            aria-haspopup="listbox"
            aria-describedby={`${id}-hint`}
            aria-invalid={!!target && !valid}
            disabled={empty}
            className="devclaw-control-shell flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left"
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key) && !empty) {
                event.preventDefault()
                setSearch("")
                setHighlight(0)
                setOpen(true)
              }
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {empty
                  ? "暂无可配置的本地聊天"
                  : selected
                    ? selected.title || "未命名聊天"
                    : target?.threadId
                      ? "原配置聊天已不可用，请重新选择"
                      : "请选择一段本地聊天"}
              </span>
              <span
                className="block truncate text-xs text-muted-foreground"
                title={target?.workspace ?? undefined}
              >
                {selected
                  ? configurationWorkspace(selected)
                  : target?.workspace || "需要具有工作目录的本地聊天"}
              </span>
            </span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="选择配置聊天"
          className="devclaw-options w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-2"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            searchRef.current?.focus()
          }}
        >
          <label className="devclaw-control-shell mb-2 flex items-center gap-2 px-2">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              aria-label="搜索配置聊天"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={visible.length ? `${id}-option-${highlighted}` : undefined}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
              placeholder="搜索聊天名称或目录"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setHighlight(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  setHighlight((index) =>
                    Math.max(
                      0,
                      Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
                    )
                  )
                } else if (event.key === "Enter" && visible[highlighted]) {
                  event.preventDefault()
                  choose(visible[highlighted])
                }
              }}
            />
          </label>
          <div
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="max-h-64 space-y-1 overflow-y-auto overscroll-contain"
          >
            {visible.map((row, index) => {
              const workspace = configurationWorkspace(row)
              const chosen = optionKey(row.thread_id, workspace) === selectedKey
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={chosen}
                  aria-label={`${row.title || "未命名聊天"} · ${workspace}`}
                  id={`${id}-option-${index}`}
                  tabIndex={-1}
                  key={optionKey(row.thread_id, workspace)}
                  className="devclaw-option flex w-full min-w-0 items-start gap-2 rounded-md p-2 text-left"
                  data-highlighted={index === highlighted || undefined}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => choose(row)}
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block break-words text-sm font-medium">
                      {row.title || "未命名聊天"}
                    </strong>
                    <span className="block break-all text-xs text-muted-foreground">
                      {workspace}
                    </span>
                  </span>
                  <Check
                    aria-hidden="true"
                    className={`mt-0.5 size-4 shrink-0 ${chosen ? "" : "invisible"}`}
                  />
                </button>
              )
            })}
          </div>
          {!visible.length && (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              没有匹配的本地聊天，请更换关键词。
            </p>
          )}
          {matches.length > visible.length && (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              显示前 100 / {matches.length} 项，请搜索名称或目录缩小范围。
            </p>
          )}
        </PopoverContent>
      </Popover>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {empty
          ? "只有具有工作目录的本地聊天可配置。请先创建或打开一段本地聊天。"
          : "切换这里只更换配置对象。应用后，点击“去这段聊天使用”再进入聊天。"}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
