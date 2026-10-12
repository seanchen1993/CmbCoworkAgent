import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import type { BotHarnessBinding } from "../../../../shared/bot-harness-context"
import type {
  HarnessFeatureSummary,
  HarnessProjectListItem
} from "../../../../shared/harness-board-types"

export function BotHarnessBindingPicker({
  value,
  onChange,
  onWorkspace,
  onValidity,
  disabled
}: {
  value: BotHarnessBinding | null
  onChange(value: BotHarnessBinding | null): void
  onWorkspace(path: string): void
  onValidity(valid: boolean): void
  disabled: boolean
}) {
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [features, setFeatures] = useState<HarnessFeatureSummary[]>([])
  const [query, setQuery] = useState("")
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [featureLoading, setFeatureLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [selectionFailure, setSelectionFailure] = useState<string | null>(null)
  const [instructionDraft, setInstructionDraft] = useState(
    value?.instructionWorkspacePaths.join("\n") ?? ""
  )
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const generation = useRef(0)
  const selection = useRef(value)
  selection.current = value
  const instructionPaths = instructionDraft
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
  const directoryOverflow = instructionPaths.length > 16
  useEffect(() => {
    const normalized = instructionDraft
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
    if (JSON.stringify(normalized) !== JSON.stringify(value?.instructionWorkspacePaths ?? []))
      setInstructionDraft(value?.instructionWorkspacePaths.join("\n") ?? "")
  }, [value?.instructionWorkspacePaths, instructionDraft])
  useEffect(() => {
    onValidity(!value || (!featureLoading && !selectionFailure && !directoryOverflow))
  }, [value, featureLoading, selectionFailure, directoryOverflow, onValidity])
  const pendingWorkspace = useRef<string | null>(null)
  const fetchProjects = async (cursor = 0, expected = generation.current) => {
    setLoading(true)
    try {
      const page = await window.api.harnessBoard.catalogPage({
        requestScope: "chat-binding",
        query,
        projectCursor: cursor,
        projectLimit: 64,
        includeRegistry: false
      })
      if (expected !== generation.current) return
      const available = page.projects.filter(
        (project) => project.lifecycle.status === "active" && project.boardCompatibility.compatible
      )
      setProjects((previous) =>
        cursor
          ? [
              ...previous,
              ...available.filter(
                (project) => !previous.some((item) => item.projectId === project.projectId)
              )
            ]
          : available
      )
      setNext(page.projectNextCursor)
      setFailure(null)
    } catch (error) {
      if (expected === generation.current)
        setFailure(error instanceof Error ? error.message : "项目目录读取失败")
    } finally {
      if (expected === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    const expected = ++generation.current
    const timer = setTimeout(() => void fetchProjects(0, expected), 150)
    return () => {
      clearTimeout(timer)
      if (generation.current === expected) generation.current = expected + 1
    }
    // The query owns the request generation; callback identity is not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  useEffect(() => {
    let cancelled = false
    setFeatures([])
    setSelectionFailure(null)
    if (!value?.projectId) {
      setFeatureLoading(false)
      return
    }
    const projectId = value.projectId
    setFeatureLoading(true)
    void window.api.harnessBoard
      .getProjectDetails([projectId], { watchRefs: false })
      .then((details) => {
        if (cancelled) return
        const detail = details[projectId]
        if (!detail || detail.error) throw new Error(detail?.error || "项目详情不可用")
        setFeatures(detail.runs.filter((feature) => feature.location !== "archived"))
        if (pendingWorkspace.current === projectId) {
          onWorkspace(detail.project.projectRootPath)
          pendingWorkspace.current = null
        }
        setFailure(null)
      })
      .catch((error) => {
        if (!cancelled)
          setSelectionFailure(error instanceof Error ? error.message : "功能目录读取失败")
      })
      .finally(() => {
        if (!cancelled) setFeatureLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Workspace changes are applied only after an explicit project selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.projectId])
  const chooseFeature = (slug: string) => {
    if (!value) return
    const updated = { ...value, featureSlug: slug === "project" ? undefined : slug.slice(8) }
    setSelectionFailure(null)
    onChange(updated)
    if (!updated.featureSlug) {
      setFeatureLoading(true)
      void window.api.harnessBoard
        .getProjectDetails([updated.projectId], { watchRefs: false })
        .then((details) => {
          if (
            !mounted.current ||
            selection.current?.projectId !== updated.projectId ||
            selection.current?.featureSlug
          )
            return
          const detail = details[updated.projectId]
          if (!detail || detail.error) throw new Error(detail?.error || "项目详情不可用")
          onWorkspace(detail.project.projectRootPath)
        })
        .catch((error) => {
          if (
            mounted.current &&
            selection.current?.projectId === updated.projectId &&
            !selection.current?.featureSlug
          )
            setSelectionFailure(error instanceof Error ? error.message : "项目工作目录读取失败")
        })
        .finally(() => {
          if (
            mounted.current &&
            selection.current?.projectId === updated.projectId &&
            !selection.current?.featureSlug
          )
            setFeatureLoading(false)
        })
      return
    }
    setFeatureLoading(true)
    void window.api.harnessBoard
      .getRunDetail(updated.projectId, updated.featureSlug)
      .then((detail) => {
        if (
          !mounted.current ||
          selection.current?.projectId !== updated.projectId ||
          selection.current?.featureSlug !== updated.featureSlug
        )
          return
        if (!detail.run.resolvedSessionWorkspacePath) throw new Error("此功能未配置工作目录")
        onWorkspace(detail.run.resolvedSessionWorkspacePath)
      })
      .catch((error) => {
        if (
          mounted.current &&
          selection.current?.projectId === updated.projectId &&
          selection.current?.featureSlug === updated.featureSlug
        )
          setSelectionFailure(error instanceof Error ? error.message : "功能工作目录读取失败")
      })
      .finally(() => {
        if (
          mounted.current &&
          selection.current?.projectId === updated.projectId &&
          selection.current?.featureSlug === updated.featureSlug
        )
          setFeatureLoading(false)
      })
  }
  const update = (fields: Partial<BotHarnessBinding>) => {
    if (value) onChange({ ...value, ...fields })
  }
  return (
    <fieldset
      className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3.5"
      disabled={disabled}
    >
      <legend className="px-1 text-sm font-medium">
        项目上下文 <span className="text-xs font-normal text-muted-foreground">可选</span>
      </legend>
      <Input
        aria-label="查找项目"
        placeholder="查找项目"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-8 rounded-lg bg-background text-xs shadow-none"
      />
      <Select
        value={value ? `project:${value.projectId}` : "none"}
        disabled={disabled}
        onValueChange={(selected) => {
          const projectId = selected.slice(8)
          pendingWorkspace.current = selected === "none" ? null : projectId
          onChange(selected === "none" ? null : { projectId, instructionWorkspacePaths: [] })
        }}
      >
        <SelectTrigger aria-label="关联项目" className="rounded-lg bg-background shadow-none">
          <SelectValue placeholder="不关联项目" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">不关联项目</SelectItem>
          {value && !projects.some((project) => project.projectId === value.projectId) && (
            <SelectItem value={`project:${value.projectId}`}>
              当前项目 · {value.projectId}
            </SelectItem>
          )}
          {projects.map((project) => (
            <SelectItem key={project.projectId} value={`project:${project.projectId}`}>
              {project.name || project.projectCode}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {next !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading || disabled}
          onClick={() => void fetchProjects(next)}
        >
          {loading ? "读取中…" : "显示更多项目"}
        </Button>
      )}
      {value && (
        <>
          <Select
            value={value.featureSlug ? `feature:${value.featureSlug}` : "project"}
            disabled={disabled || featureLoading}
            onValueChange={chooseFeature}
          >
            <SelectTrigger
              aria-label="关联项目功能"
              className="rounded-lg bg-background shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">整个项目</SelectItem>
              {value.featureSlug &&
                !features.some((feature) => feature.slug === value.featureSlug) && (
                  <SelectItem value={`feature:${value.featureSlug}`}>
                    当前功能 · {value.featureSlug}
                  </SelectItem>
                )}
              {features.map((feature) => (
                <SelectItem key={feature.slug} value={`feature:${feature.slug}`}>
                  {feature.title || feature.slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            沿用项目插件的工作指令、技能范围和检查规则。首次运行需要确认插件检查。
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
              更多项目设置
            </summary>
            <div className="mt-3 space-y-3">
              <label className="block space-y-1.5">
                <span>额外指令目录（每行一个绝对路径）</span>
                <textarea
                  aria-label="授权额外项目指令目录"
                  value={instructionDraft}
                  onChange={(event) => {
                    setInstructionDraft(event.target.value)
                    update({
                      instructionWorkspacePaths: event.target.value
                        .split(/\r?\n/)
                        .map((path) => path.trim())
                        .filter(Boolean)
                    })
                  }}
                  maxLength={65_536}
                  rows={2}
                  className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <span className="block leading-relaxed">
                  只授权读取 AGENTS.md。代码修改和命令仍限于上面的工作目录。
                </span>
              </label>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="bot-harness-auto-question">允许问题等待超时后自动处理</label>
                <Switch
                  id="bot-harness-auto-question"
                  disabled={disabled}
                  checked={value.requestUserInputConfig?.allowAutoResolution ?? false}
                  onCheckedChange={(checked) =>
                    update({
                      requestUserInputConfig: {
                        allowAutoResolution: checked,
                        autoResolutionType: "select_first",
                        defaultTimeoutMs: 60_000
                      }
                    })
                  }
                />
              </div>
              {value.requestUserInputConfig?.allowAutoResolution && (
                <p className="leading-relaxed">
                  默认等待 60 秒后采用首个选项；Bot 可为非阻塞问题设置 30–240 秒。审批仍需单独确认。
                </p>
              )}
            </div>
          </details>
        </>
      )}
      {loading && !projects.length && (
        <p role="status" className="text-xs text-muted-foreground">
          正在读取项目…
        </p>
      )}
      {(selectionFailure || directoryOverflow) && (
        <p role="alert" className="text-xs text-destructive">
          {directoryOverflow ? "最多授权 16 个额外指令目录。" : selectionFailure}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </fieldset>
  )
}
