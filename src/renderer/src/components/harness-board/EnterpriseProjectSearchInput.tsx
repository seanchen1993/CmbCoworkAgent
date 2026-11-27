import { useCallback, useEffect, useRef, useState } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Popover, PopoverAnchor } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import type { HarnessEnterpriseProjectSearchItem } from "../../../../shared/harness-board-types"

export const harnessProjectCreateInputClassName =
  "bg-background text-foreground placeholder:text-muted-foreground/45"
export const harnessProjectPopoverContentClassName =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[70] origin-[var(--radix-popover-content-transform-origin)] w-[var(--radix-popover-trigger-width)] rounded-md border p-0 shadow-md outline-none"
export const ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS = 300
const ENTERPRISE_PROJECT_SEARCH_MIN_CHARS = 2
export function cleanIpcError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/, "")
}

export function EnterpriseProjectSearchInput({
  value,
  searchField,
  searchLabel,
  placeholder,
  showEmptyResults = false,
  normalizeValue,
  onValueChange,
  onSelect,
  ariaInvalid,
  autoFocus,
  portalContainer
}: {
  value: string
  searchField: "name" | "code"
  searchLabel: string
  placeholder?: string
  showEmptyResults?: boolean
  normalizeValue?: (value: string) => string
  onValueChange: (value: string) => void
  onSelect: (project: HarnessEnterpriseProjectSearchItem) => void
  ariaInvalid?: boolean
  autoFocus?: boolean
  portalContainer?: HTMLElement | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [projects, setProjects] = useState<HarnessEnterpriseProjectSearchItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState("")
  const requestIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const keyword = searchKeyword.trim() === value.trim() ? searchKeyword.trim() : ""
  const shouldShowPopover =
    open &&
    keyword.length > 0 &&
    (loading ||
      projects.length > 0 ||
      (showEmptyResults && searched) ||
      (keyword.length > 0 && keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS))

  const clearSearchState = useCallback(() => {
    requestIdRef.current += 1
    setSearchKeyword("")
    setLoading(false)
    setProjects([])
    setHasMore(false)
    setSearched(false)
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!keyword || keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS) return

    let canceled = false
    const timer = window.setTimeout(() => {
      const nextRequestId = requestIdRef.current + 1
      requestIdRef.current = nextRequestId
      setOpen(inputRef.current === document.activeElement)
      setLoading(true)
      window.api.harnessBoard
        .searchEnterpriseProjects({ keyword, field: searchField })
        .then((result) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setProjects(result.projects)
          setHasMore(result.hasMore)
          setSearched(true)
          setOpen(
            inputRef.current === document.activeElement &&
              (result.projects.length > 0 || showEmptyResults)
          )
        })
        .catch((error) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setProjects([])
          setHasMore(false)
          setOpen(false)
          toast.error(cleanIpcError(error))
        })
        .finally(() => {
          if (!canceled && requestIdRef.current === nextRequestId) setLoading(false)
        })
    }, ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [keyword, searchField, showEmptyResults])

  const handleSelect = (project: HarnessEnterpriseProjectSearchItem): void => {
    clearSearchState()
    onSelect(project)
  }

  return (
    <Popover
      open={shouldShowPopover}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true)
          return
        }
        clearSearchState()
      }}
    >
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => {
            const nextValue = normalizeValue
              ? normalizeValue(event.target.value)
              : event.target.value
            requestIdRef.current += 1
            setSearchKeyword(nextValue)
            setLoading(false)
            setProjects([])
            setHasMore(false)
            setSearched(false)
            onValueChange(nextValue)
            setOpen(nextValue.trim().length > 0)
          }}
          onFocus={() => {
            if (keyword) setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && open && projects.length > 0) {
              event.preventDefault()
              listRef.current?.querySelector("button")?.focus()
            }
          }}
          placeholder={
            placeholder ??
            (searchField === "code" ? "输入项目编号搜索，存在 T+1 延迟" : `输入${searchLabel}搜索`)
          }
          className={harnessProjectCreateInputClassName}
          aria-autocomplete="list"
          aria-invalid={ariaInvalid ? true : undefined}
        />
      </PopoverAnchor>
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          data-slot="popover-content"
          align="start"
          sideOffset={4}
          className={harnessProjectPopoverContentClassName}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="max-h-72 overflow-hidden py-1 text-sm">
            {keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                继续输入{searchLabel}以搜索
              </div>
            ) : loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                搜索项目...
              </div>
            ) : projects.length > 0 ? (
              <>
                <div ref={listRef} className="max-h-60 overscroll-y-contain overflow-y-auto py-1">
                  {projects.map((project) => (
                    <button
                      key={`${project.projectCode}:${project.projectName}`}
                      type="button"
                      className="group grid w-full cursor-pointer gap-1.5 px-2 py-2 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                      onClick={() => handleSelect(project)}
                      onKeyDown={(event) => {
                        const button = event.currentTarget
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault()
                          const next =
                            event.key === "ArrowDown"
                              ? button.nextElementSibling
                              : (button.previousElementSibling ?? inputRef.current)
                          if (next instanceof HTMLElement) next.focus()
                        }
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2 text-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                        <span className="shrink-0 font-mono">{project.projectCode || "-"}</span>
                        <span className="min-w-0 truncate">{project.projectName || "-"}</span>
                      </span>
                      <span className="truncate text-xs leading-5 text-muted-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                        项目经理：{project.pm || "-"}
                      </span>
                    </button>
                  ))}
                </div>
                {hasMore && (
                  <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                    仅显示前 15 条，请输入更精确的关键词
                  </div>
                )}
              </>
            ) : showEmptyResults && searched ? (
              <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
                未找到匹配的精益项目，仍可使用填写的名称。
              </div>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  )
}

export interface EnterpriseProjectCodeVerification {
  pending: boolean
  error: string | null
}

export function useEnterpriseProjectCodeVerification(
  enabled: boolean,
  projectCode: string,
  onVerified: (linked: boolean) => void
): EnterpriseProjectCodeVerification {
  const requestIdRef = useRef(0)
  const [verification, setVerification] = useState({
    enabled,
    projectCode,
    pending: true,
    error: null as string | null
  })
  const matchesCurrentInput =
    verification.enabled === enabled && verification.projectCode === projectCode
  if (!matchesCurrentInput) {
    setVerification({ enabled, projectCode, pending: true, error: null })
  }

  useEffect(() => {
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    if (!enabled) return

    const normalizedProjectCode = projectCode.trim()
    if (!normalizedProjectCode) {
      onVerified(false)
      return
    }

    const timer = window.setTimeout(() => {
      window.api.harnessBoard
        .verifyEnterpriseProjectCode(normalizedProjectCode)
        .then((linked) => {
          if (requestIdRef.current !== requestId) return
          onVerified(linked)
          setVerification({ enabled, projectCode, pending: false, error: null })
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return
          // 查询失败时保留现有状态，并允许用户继续保存。
          setVerification({ enabled, projectCode, pending: false, error: "关联精益项目失败" })
        })
    }, ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      requestIdRef.current += 1
    }
  }, [enabled, onVerified, projectCode])

  // 编号变化的当次渲染就阻止保存，覆盖 effect 执行前和防抖等待期间。
  return {
    pending: enabled && !!projectCode.trim() && (!matchesCurrentInput || verification.pending),
    error: enabled && matchesCurrentInput ? verification.error : null
  }
}
