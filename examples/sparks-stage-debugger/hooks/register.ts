import type { On, JsonObject } from "claude-code"

const target = { kind: "current" as const }
const nativeRef = { provider: "native.project-stage-debug", id: "stages", version: "1.0.0" }
const object = { type: "object" }

/** Runs in the Creator control conversation. The isolated execution branch loads no Mods. */
export function register(on: On) {
  let snapshots: JsonObject[] = [], drafts: JsonObject[] = [], branches: JsonObject[] = []
  let selectedSnapshot = "", selectedDraft = "", result: JsonObject | undefined
  let status = "请在已启用创造者模式的原会话中打开。", sequence = 0
  let snapshotOffset = 0, branchOffset = 0
  let nextSnapshots: number | undefined, nextBranches: number | undefined

  on.capability({
    apiVersion: "devclaw.capability/v1", id: "stage-debugger", version: "1.0.0",
    title: "阶段调试工作台", scope: "conversation", stateSchema: object,
    presentation: { type: "surface", apiVersion: "devclaw.surface/v1", id: "stage-debugger",
      title: "阶段调试工作台", placement: "sidebar", paneId: "stage-debugger", openAction: "open" },
    actions: [{ id: "open", title: "发现本会话快照", inputSchema: object, outputSchema: object,
      requiredPermissions: ["platform.read", "ui.open", "ui.invalidate"],
      cancellable: true, idempotency: "keyed" }]
  }, {
    async act($): Promise<JsonObject> {
      // Native surface-open lifetime permits observation and drawing, never platform.act.
      const state = await $.platform.read({ ref: nativeRef, target })
      status = state.status === "ready" && (state.value as JsonObject)?.status === "ready"
        ? "已连接原生服务。点击刷新，读取当前快照和候选。" : "当前来源不可用，请核对创造者模式与原试用。"
      await $.ui.open({ id: "stage-debugger", title: "阶段调试工作台" })
      return { opened: true, executionGranted: false }
    }
  })
  on("ui.render", { component: "Pane", requestId: "stage-debugger" }, ($, event) => {
    // Keep SDK calls inside their actual hook closure. Passing the SDK to generic helpers
    // would escape the existing static audit's proven identity and permission analysis.
    async function invoke(action: string, input: JsonObject): Promise<JsonObject> {
      const request = await $.platform.act({ ref: nativeRef, target, action, input,
        requestKey: "stage-debugger-" + (++sequence) + "-" + Date.now() })
      if (request.status !== "succeeded")
        throw Error(String(request.error || request.status) + "；结果未确认，不会自动重放。")
      return request.value as JsonObject
    }
    async function refresh() {
      const state = await $.platform.read({ ref: nativeRef, target })
      if (state.status !== "ready" || (state.value as JsonObject)?.status !== "ready") {
        snapshots = []; drafts = []; branches = []; result = undefined
        selectedSnapshot = ""; selectedDraft = ""
        status = "当前原生来源不可用；请启用创造者模式并核对原试用。"
        return
      }
      const snapshotPage = await invoke("inspect", { kind: "snapshots", offset: snapshotOffset })
      const draftPage = await invoke("inspect", { kind: "drafts" })
      const branchPage = await invoke("inspect", { kind: "branches", offset: branchOffset })
      snapshots = snapshotPage.items as JsonObject[]
      drafts = draftPage.items as JsonObject[]
      branches = branchPage.items as JsonObject[]
      nextSnapshots = snapshotPage.nextOffset as number | undefined
      nextBranches = branchPage.nextOffset as number | undefined
      if (!snapshots.some((item) => item.id === selectedSnapshot)) selectedSnapshot = ""
      if (!drafts.some((item) => item.id === selectedDraft)) selectedDraft = ""
      status = "状态来自原生服务。方案准备成功不代表运行或产物检查通过。"
    }
    async function perform(work: () => Promise<void>) {
      try { await work() } catch (error) { status = String(error); result = undefined }
      $.ui.invalidate("ui.render")
    }
    const { Box, Text, Button, Table } = $.ui.resolve(event)
    const button = (key: string, label: string, work: () => Promise<void>) =>
      Button({ key, label, onPress: () => perform(work) })
    return Box({ flexDirection: "column", gap: 1, children: [
      Text({ children: status }),
      button("refresh", "刷新原生状态", async () => { result = undefined; await refresh() }),
      Text({ children: "选择阶段进入前的快照（仅文件，不回退数据库、网络或Git）" }),
      ...snapshots.map((item) => button("snapshot-" + item.id,
        (selectedSnapshot === item.id ? "已选：" : "选择：") + item.stageTitle +
          " · 项目 " + String(item.projectId).slice(0, 12) + " · " + new Date(Number(item.createdAt)).toISOString() +
          " · 快照 " + String(item.id).slice(0, 12),
        async () => { selectedSnapshot = String(item.id); result = undefined })),
      ...(snapshotOffset > 0 ? [button("snap-first", "返回快照首页", async () => {
        snapshotOffset = 0; result = undefined; await refresh()
      })] : []),
      ...(nextSnapshots !== undefined ? [button("snap-next", "下一页快照", async () => {
        snapshotOffset = nextSnapshots!; result = undefined; await refresh()
      })] : []),
      ...snapshots.filter(item => item.id === selectedSnapshot).map(item => Text({
        children: "已选输入快照：" + item.id + "；来源项目：" + item.projectId +
          "；阶段：" + item.stageId + "；保存时间：" + new Date(Number(item.createdAt)).toISOString() +
          "；原源码摘要：" + item.sourceDigest
      })),
      Text({ children: "选择已保存并修改正文的候选" }),
      ...drafts.map((item) => button("draft-" + item.id,
        (selectedDraft === item.id ? "已选：" : "选择：") + item.name + " r" + item.revision +
          " · 候选 " + String(item.id) + " · " + String(item.digest).slice(0, 12),
        async () => { selectedDraft = String(item.id); result = undefined })),
      ...drafts.filter(item => item.id === selectedDraft).map(item => Text({
        children: "已选候选：" + item.id + "；版本：" + item.revision + "；完整摘要：" + item.digest
      })),
      ...(["stage", "downstream"] as const).map((mode) => button("prepare-" + mode,
        mode === "stage" ? "准备单阶段调试" : "准备从此阶段重跑后续", async () => {
          const candidate = drafts.find((item) => item.id === selectedDraft)
          if (!candidate || !selectedSnapshot) throw Error("请先明确选择快照和候选。")
          result = await invoke("prepare", { snapshotId: selectedSnapshot, draftId: String(candidate.id),
            revision: Number(candidate.revision), expectedDigest: String(candidate.digest), mode })
          status = "方案已校验；尚未创建、执行或批准。"
        })),
      ...(result ? [
        Text({ children: "候选摘要：" + result.candidateDigest + "；影响阶段：" + JSON.stringify(result.affectedStageIds) }),
        Text({ children: JSON.stringify(result.diagnostics) }),
        ...(result.canReview ? [button("review", "前往原生复核（另行确认创建和执行）", async () => {
          const answer = await invoke("review", { planId: String(result!.planId) })
          status = answer.queued ? "原生复核跳转已排队；请在原生工作区重新核对并确认。"
            : answer.requested ? "已记录复核意图；请打开原创造会话的工作区核对。" : "复核请求未确认。"
          result = undefined
        })] : [Text({ children: "原生复核跳转未接入；方案没有执行权限。" })])
      ] : []),
      Table({ label: "原生分支历史结果（按固定候选归属）", columns: [{ key: "stageId", label: "阶段" },
        { key: "status", label: "原生结果" }, { key: "candidateDigest", label: "固定候选摘要" },
        { key: "match", label: "当前候选" }], rows: branches.map((item) => ({
          stageId: String(item.stageId), status: String(item.status), candidateDigest: String(item.candidateDigest),
          match: item.currentCandidateMatches === true ? "摘要一致，仍须核对原生记录" : "历史版本结果，不代表当前候选通过"
        })) }),
      ...(nextBranches !== undefined ? [button("branch-next", "下一页调试结果", async () => {
        branchOffset = nextBranches!; await refresh()
      })] : []),
      ...(branchOffset > 0 ? [button("branch-first", "返回结果首页", async () => {
        branchOffset = 0; await refresh()
      })] : [])
    ] })
  })
}
