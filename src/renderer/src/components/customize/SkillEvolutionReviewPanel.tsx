import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCircle2, Loader2, RefreshCcw, Rocket, RotateCcw, ShieldCheck, Trash2, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { evolutionApi, type EvolutionCandidate } from "@/api/evolution"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import { trackCloudEvolutionCandidatePublished } from "@/lib/cloud-evolution-events"
import { extractTextBundleFromZip, type TextBundleFile } from "@/lib/skill-bundle-diff"
import { SkillBundleMergeEditor } from "./SkillBundleMergeEditor"

function statusLabel(status: string): string {
  return {
    awaiting_review: "待审批",
    approved: "已通过",
    rejected: "已拒绝",
    published: "已发布"
  }[status] ?? status
}

function scoreLabel(score?: string | null): string {
  if (!score) return "—"
  const value = Number(score)
  if (!Number.isFinite(value)) return score
  return value.toFixed(2)
}

export function SkillEvolutionReviewPanel(): React.JSX.Element {
  const [items, setItems] = useState<EvolutionCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diff, setDiff] = useState("")
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [draftEditorOpen, setDraftEditorOpen] = useState(false)
  const [draftEditorLoading, setDraftEditorLoading] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftBaseFiles, setDraftBaseFiles] = useState<TextBundleFile[]>([])
  const [draftFiles, setDraftFiles] = useState<TextBundleFile[]>([])
  const [useLocalDebugEndpoint, setUseLocalDebugEndpoint] = useState(() => evolutionApi.isLocalDebugEndpointEnabled())
  const selected = useMemo(
    () => items.find((item) => item.candidate_id === selectedId) || items[0] || null,
    [items, selectedId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [awaiting, approved, published, rejected] = await Promise.all([
        evolutionApi.listCandidates("awaiting_review", 50),
        evolutionApi.listCandidates("approved", 20),
        evolutionApi.listCandidates("published", 20),
        evolutionApi.listCandidates("rejected", 20)
      ])
      const merged = [...awaiting, ...approved, ...published, ...rejected]
      setItems(merged)
      setSelectedId((prev) => prev && merged.some((item) => item.candidate_id === prev) ? prev : merged[0]?.candidate_id ?? null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载候选失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selected) {
      setDiff("")
      return
    }
    let cancelled = false
    evolutionApi.getDiff(selected.candidate_id)
      .then((value) => {
        if (!cancelled) setDiff(value)
      })
      .catch((error) => {
        if (!cancelled) setDiff(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const reviewer = localStorage.getItem("userName") || localStorage.getItem("ystId") || "admin"

  const refreshSelectedDiff = useCallback(async (candidateId: string): Promise<void> => {
    try {
      setDiff(await evolutionApi.getDiff(candidateId))
    } catch (error) {
      setDiff(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const toggleLocalDebugEndpoint = useCallback(() => {
    const next = !useLocalDebugEndpoint
    evolutionApi.setLocalDebugEndpointEnabled(next)
    setUseLocalDebugEndpoint(next)
    setItems([])
    setSelectedId(null)
    setDiff("")
    void load()
  }, [load, useLocalDebugEndpoint])

  const openDraftEditor = useCallback(async (candidate: EvolutionCandidate): Promise<void> => {
    setDraftEditorLoading(true)
    try {
      const [baseBundle, bundle] = await Promise.all([
        evolutionApi.downloadCandidateBaseBundle(candidate.candidate_id),
        evolutionApi.downloadCandidateBundle(candidate.candidate_id)
      ])
      const [baseFiles, files] = await Promise.all([
        extractTextBundleFromZip(await baseBundle.blob.arrayBuffer()),
        extractTextBundleFromZip(await bundle.blob.arrayBuffer())
      ])
      setDraftBaseFiles(baseFiles)
      setDraftFiles(files)
      setDraftEditorOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载候选草稿失败")
    } finally {
      setDraftEditorLoading(false)
    }
  }, [])

  const saveDraft = useCallback(async (files: TextBundleFile[]): Promise<void> => {
    if (!selected) return
    setDraftSaving(true)
    try {
      const updated = await evolutionApi.saveDraft(selected.candidate_id, files, reviewer, selected.notes || undefined)
      setItems((prev) => prev.map((item) => item.candidate_id === updated.candidate_id ? updated : item))
      setDraftEditorOpen(false)
      await refreshSelectedDiff(selected.candidate_id)
      toast.success("候选草稿已保存")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存候选草稿失败")
      throw error
    } finally {
      setDraftSaving(false)
    }
  }, [refreshSelectedDiff, reviewer, selected])

  async function runAction(action: "approve" | "reject" | "publish" | "unpublish" | "delete", candidate: EvolutionCandidate): Promise<void> {
    if (action === "delete") {
      if (!confirm(`确定要删除候选 ${candidate.skill_name} (${candidate.candidate_id}) 吗？此操作不可撤销。`)) return
    } else if (action === "unpublish") {
      if (!confirm(`确定要撤回发布 ${candidate.skill_name} (${candidate.candidate_id}) 吗？撤回后该候选会回到已通过状态，可重新发布。`)) return
    }
    setActionLoading(`${action}:${candidate.candidate_id}`)
    try {
      if (action === "approve") {
        await evolutionApi.approve(candidate.candidate_id, reviewer)
        toast.success("候选已通过")
      } else if (action === "reject") {
        await evolutionApi.reject(candidate.candidate_id, reviewer)
        toast.success("候选已拒绝")
      } else if (action === "delete") {
        await evolutionApi.deleteCandidate(candidate.candidate_id)
        toast.success("候选已删除")
      } else if (action === "unpublish") {
        await evolutionApi.unpublish(candidate.candidate_id)
        toast.success("已撤回发布")
      } else {
        const published = await evolutionApi.publish(candidate.candidate_id, reviewer)
        trackCloudEvolutionCandidatePublished(published, reviewer)
        toast.success("候选已发布到自进化更新通道")
      }
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败")
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden bg-[#faf9f5]">
      <div className="w-[360px] border-r border-[#ebe8dd] flex flex-col">
        <div className="p-5 border-b border-[#ebe8dd]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-[#181713]">技能进化审批</h2>
              <p className="mt-1 text-sm text-[#7b7970]">审阅 Trace Evolver 生成的候选补丁。</p>
              <div className="mt-3 flex min-w-0 items-start gap-2 text-xs leading-5 text-[#7b7970]">
                <button
                  type="button"
                  role="switch"
                  aria-checked={useLocalDebugEndpoint}
                  onClick={toggleLocalDebugEndpoint}
                  className={cn(
                    "relative mt-px h-5 w-9 shrink-0 rounded-full border transition-colors",
                    useLocalDebugEndpoint ? "border-[#3b68a8] bg-[#3b68a8]" : "border-[#d8d3c2] bg-[#eeeae0]"
                  )}
                  title="开启后所有 Trace Evolver 请求走本地 8017"
                >
                  <span
                    className={cn(
                      "absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform",
                      useLocalDebugEndpoint ? "translate-x-4" : "translate-x-0"
                    )}
                  />
                </button>
                <span className="min-w-0 text-left">连接本地Trace Evolver服务(开发者调试使用)</span>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-2">
            {items.length === 0 && (
              <div className="rounded-xl border border-dashed border-[#d8d3c2] p-5 text-sm text-[#7b7970]">
                暂无待审批候选。Trace Evolver 跑完后会出现在这里。
              </div>
            )}
            {items.map((item) => (
              <button
                key={item.candidate_id}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-colors",
                  selected?.candidate_id === item.candidate_id
                    ? "border-[#3b68a8] bg-white"
                    : "border-[#ebe8dd] bg-[#fffdf8] hover:bg-white"
                )}
                onClick={() => setSelectedId(item.candidate_id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[#181713] truncate">{item.skill_name}</span>
                  <span className="rounded-full bg-[#eef5ff] px-2 py-0.5 text-[11px] text-[#3b68a8]">
                    {statusLabel(item.evolution_status)}
                  </span>
                </div>
                <div className="mt-2 text-xs text-[#7b7970]">
                  {item.source_version || "unknown"} → {item.target_version || "unknown"} · score {scoreLabel(item.evaluation_score)}
                </div>
                <div className="mt-1 text-xs text-[#9a9688] truncate">{item.candidate_id}</div>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[#7b7970]">请选择一个候选。</div>
        ) : (
          <>
            <div className="border-b border-[#ebe8dd] bg-white px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="size-5 text-[#3b68a8]" />
                    <h3 className="text-base font-semibold text-[#181713]">{selected.skill_name}</h3>
                  </div>
                  <p className="mt-1 text-sm text-[#7b7970]">
                    变更文件 {selected.files_changed.length} 个，来源 trace {selected.source_trace_ids.length} 条。
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={Boolean(actionLoading) || draftEditorLoading || selected.evolution_status === "published"}
                    onClick={() => void openDraftEditor(selected)}
                  >
                    {draftEditorLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCcw className="mr-1.5 size-4" />}
                    编辑草稿
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(actionLoading) || selected.evolution_status !== "awaiting_review"}
                    onClick={() => void runAction("reject", selected)}
                  >
                    <XCircle className="mr-1.5 size-4" />拒绝
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(actionLoading) || selected.evolution_status !== "awaiting_review"}
                    onClick={() => void runAction("approve", selected)}
                  >
                    <CheckCircle2 className="mr-1.5 size-4" />通过
                  </Button>
                  <Button
                    disabled={Boolean(actionLoading) || selected.evolution_status !== "approved"}
                    onClick={() => void runAction("publish", selected)}
                  >
                    <Rocket className="mr-1.5 size-4" />发布
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(actionLoading) || selected.evolution_status !== "published"}
                    onClick={() => void runAction("unpublish", selected)}
                  >
                    <RotateCcw className="mr-1.5 size-4" />撤回发布
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(actionLoading)}
                    onClick={() => void runAction("delete", selected)}
                  >
                    <Trash2 className="mr-1.5 size-4" />删除
                  </Button>
                </div>
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4 p-5">
                <div className="space-y-3">
                  <Info label="推荐" value={selected.recommendation || "—"} />
                  <Info label="当前版本" value={selected.source_version || "—"} />
                  <Info label="目标版本" value={selected.target_version || "—"} />
                  <Info label="状态" value={statusLabel(selected.evolution_status)} />
                  <Info label="候选 ID" value={selected.candidate_id} />
                </div>
                <div className="min-h-[540px] overflow-hidden rounded-xl border border-[#ebe8dd] bg-white">
                  {diff ? (
                    <DiffDisplay diff={diff} />
                  ) : (
                    <div className="flex min-h-[220px] items-center justify-center text-sm text-[#7b7970]">
                      暂无 diff
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </>
        )}
      </div>
      <SkillBundleMergeEditor
        open={draftEditorOpen}
        title={`编辑候选草稿：${selected?.skill_name || ""}`}
        description="保存后，审批 diff、通过和发布都会使用这份草稿。"
        baseFiles={draftBaseFiles}
        initialFiles={draftFiles}
        confirmLabel="保存草稿"
        saving={draftSaving}
        onOpenChange={setDraftEditorOpen}
        onConfirm={saveDraft}
      />
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[#ebe8dd] bg-white p-3">
      <div className="text-xs text-[#9a9688]">{label}</div>
      <div className="mt-1 break-all text-sm text-[#181713]">{value}</div>
    </div>
  )
}
