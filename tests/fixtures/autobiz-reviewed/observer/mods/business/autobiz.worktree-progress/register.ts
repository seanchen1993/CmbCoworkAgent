/** A plugin-owned observer using existing public Mods APIs. No registration IO. */
const CAPABILITY = "autobiz.worktree-progress"
const PANE = "autobiz-worktree-progress"
const object = { type: "object", properties: {}, additionalProperties: false }

export function register(on) {
  let snapshot = null
  let selectedFeature = ""
  let selectedRun = ""
  let notice = "尚未读取。请点击刷新并核对原生权限；打开面板不会执行进程。"
  let busy = false

  const identifier = (value) => {
    const clean = typeof value === "string" ? value.trim() : ""
    if (clean && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(clean))
      throw Error("请输入原 Feature/Run 标识，只允许字母、数字、点、横线和下划线。")
    return clean
  }
  async function refresh($) {
    if (busy) return
    busy = true
    // Clear prior successful facts first: a denied/failed refresh must not leave
    // an apparently current green snapshot from a different run or workspace.
    snapshot = null
    try {
      const workspace = await $.session.root()
      if (typeof workspace !== "string" || !workspace) throw Error("当前聊天没有项目目录。")
      const argv = ["python", "-B", "-X", "utf8", $.plugin.root +
        "/mods/business/autobiz.worktree-progress/inspect.py", "--workspace", workspace]
      if (selectedFeature) argv.push("--feature", selectedFeature)
      if (selectedRun) argv.push("--run-id", selectedRun)
      const result = await $.process.run(argv, {
        cwd: workspace,
        env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
        timeoutMs: 30000
      })
      if (result.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.length > 245760)
        throw Error("只读进度读取未成功；没有沿用旧结果。")
      const value = JSON.parse(result.stdout)
      if (value.apiVersion !== "autobiz.worktree-progress/v1" || !Array.isArray(value.rows) ||
          value.rows.length > 24 || !Array.isArray(value.runs) || !Array.isArray(value.diagnostics))
        throw Error("进度格式无法确认。")
      const identity = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      if (typeof value.workspace !== "string" || identity(value.workspace) !== identity(workspace))
        throw Error("读取工作区发生变化，请重新打开面板。")
      snapshot = value
      notice = value.status === "unknown" ? "没有可核对的并行记录。请检查工作目录或明确 Feature。" :
        "已读取真实持久记录及现场 Git。运行中不等于进程仍存活，记录通过不等于当前代码已通过。"
    } catch (error) {
      notice = "unknown：" + String(error).slice(0, 300)
    } finally {
      busy = false
      await $.ui.invalidate("ui.render")
    }
  }

  on.capability({
    apiVersion: "devclaw.capability/v1", id: CAPABILITY, version: "1.0.0",
    title: "并行 Worktree 进度", scope: "conversation", stateSchema: object,
    presentation: {
      type: "surface", apiVersion: "devclaw.surface/v1", id: CAPABILITY,
      title: "并行 Worktree 进度", placement: "sidebar", paneId: PANE, openAction: "open"
    },
    actions: [{
      id: "open", title: "打开只读进度面板",
      inputSchema: { type: "object", properties: { surfaceId: { type: "string" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { opened: { type: "boolean" } }, required: ["opened"], additionalProperties: false },
      requiredPermissions: ["ui.open"], cancellable: false, idempotency: "keyed"
    }]
  }, {
    async act($) {
      await $.ui.open({ id: PANE, title: "AutoBiz · 并行 Worktree 进度", rows: 28 })
      return { opened: true }
    }
  })
  on("ui.render", { component: "Pane", requestId: PANE }, ($, event) => {
    const { Box, Text, Button, Table, Form, List } = $.ui.resolve(event)
    const rows = snapshot ? snapshot.rows : []
    const observedAt = snapshot ? Date.parse(snapshot.observedAt) : NaN
    const staleView = Number.isFinite(observedAt) && Date.now() - observedAt > 300000
    return Box({ flexDirection: "column", gap: 1, children: [
      Text({ bold: true, children: "AutoBiz · 并行 Worktree 进度" }),
      Text({ children: "技能作者提供的普通 Mod。只读调度记录和 Git，不操作工作树、不运行测试、不推进阶段。" }),
      Form({
        key: "progress-filter", label: "按原记录筛选（留空查看有界快照）",
        fields: [
          { name: "feature", label: "Feature 标识", type: "text" },
          { name: "run", label: "Run 标识", type: "text" }
        ], values: { feature: selectedFeature, run: selectedRun }, submitLabel: "筛选并刷新真实进度",
        onSubmit: async (json) => {
          const values = JSON.parse(json)
          selectedFeature = identifier(values.feature)
          selectedRun = identifier(values.run)
          await refresh($)
        }
      }),
      Button({ key: "refresh-worktrees", label: "刷新真实 Worktree 进度（保留执行审批）",
        onPress: () => refresh($) }),
      Text({ children: busy ? "正在只读核对；未推断执行进度。" : notice }),
      Text({ children: snapshot ?
        `快照：${snapshot.observedAt} · ${staleView ? "stale（请刷新）" : snapshot.status} · ${snapshot.workspace}` :
        "unknown：没有已读取快照。" }),
      ...(snapshot ? [Text({ children:
        `已显示 ${snapshot.summary.batches} 个 Batch，调度记录 merged ${snapshot.summary.recordedMerged}，现场 Git 可核对 ${snapshot.summary.gitObserved}，过期记录 ${snapshot.summary.stale}。没有估算百分比。`
      })] : []),
      Table({ label: "每个 Worktree 的实际记录", columns: [
        { key: "batch", label: "Feature / Run / Batch" },
        { key: "scheduler", label: "调度记录 / 新鲜度" },
        { key: "tasks", label: "计划任务完成记录" },
        { key: "git", label: "现场 Git / 分支 / HEAD" },
        { key: "checks", label: "阶段检查记录（非当前验收）" }
      ], rows: rows.map(row => ({
        batch: `${row.feature} / ${row.runId} / ${row.batchId}`,
        scheduler: `${row.status} · ${row.activeStage} · ${row.freshness} · lease ${row.lease}`,
        tasks: `${row.taskProgress.done === null ? "?" : row.taskProgress.done}/${row.taskProgress.total}；${Object.entries(row.taskProgress.statuses || {}).map(([status, count]) => status + ":" + count).join(" / ") || "unknown"}；只来自原 Batch plan`,
        git: row.git.status === "observed" ?
          `${row.git.branch} · ${row.git.head.slice(0, 12)} · tracked修改 ${row.git.trackedChanges} · 记录SHA${row.git.recordedHeadMatches === null ? "未知" : row.git.recordedHeadMatches ? "匹配" : "已不同"}` :
          `unknown：${row.git.reason || "未核对"}；记录分支 ${row.recordedBranch}`,
        checks: row.checks.map(check => `${check.stage}:${check.recordedStatus} (${check.evidence})`).join(" / ")
      })) }),
      List({ label: "原 Worktree 路径（只作展示，不打开外部目录）", items: rows.map((row, index) => ({
        id: "path-" + index, label: row.batchId, detail: row.worktreePath
      })) }),
      List({ label: "合并列车与最终验证记录", items: snapshot ? snapshot.runs.map((run, index) => ({
        id: "run-" + index, label: `${run.feature} / ${run.runId}: ${run.status} · ${run.freshness}`,
        detail: `updated ${run.updatedAt}；merge ${run.mergeTrains.map(train => train.id + ":" + train.status).join(", ") || "unknown"}；validation ${run.validationBatches.map(batch => batch.id + ":" + batch.status).join(", ") || "unknown"}`
      })) : [] }),
      List({ label: "读取边界与异常", items: snapshot ? snapshot.diagnostics.map((item, index) => ({
        id: "diagnostic-" + index, label: [item.feature, item.runId].filter(Boolean).join(" / ") || "unknown", detail: item.reason
      })) : [] }),
      Text({ children: "最近更新只表示持久记录较新，不证明 worker 存活。stale/expired 不推断崩溃；外部代码仓库未获当前目录范围则保持 out_of_scope。证据 bytes_match 仅核对记录自身，不替代原检查、当前 HEAD 验证或业务认可。" })
    ] })
  })
}
