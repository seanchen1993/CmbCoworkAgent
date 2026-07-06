export const meta = {
  name: "长程需求自动开发流程",
  description: "将明确需求拆成任务清单，按任务实现、验证、修复，并用状态文件支持续跑。",
  whenToUse:
    "当需求较复杂、可能跨多个模块或需要多轮实现验证时使用。小改动可继续使用轻量版需求自动开发流程。同一需求重跑即续跑；可选 args：artifactDir、outputPath、resume:false、replan:true、forceTaskIds、maxTasks（单次运行执行预算,超出任务自动留待续跑分批）、maxFixRounds。",
  phases: [
    { title: "需求整理" },
    { title: "项目探索" },
    { title: "任务规划" },
    { title: "任务执行" },
    { title: "总体验证" },
    { title: "交付报告" }
  ]
}

const WORKFLOW_VERSION = 1
const DEFAULT_ARTIFACT_ROOT = ".cmbdevclaw/长程自动开发工作流"
const MAX_MANIFESTS = 16
const MAX_SOURCE_FILES = 500
const MAX_TASKS = 12
const MAX_FIX_ROUNDS = 2
const MAX_CHANGED_FILES = 120

const REQUIREMENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    problem: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    nonGoals: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" }, minItems: 1 },
    constraints: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    canProceed: { type: "boolean" },
    proceedReason: { type: "string" }
  },
  required: [
    "title",
    "problem",
    "goal",
    "nonGoals",
    "acceptanceCriteria",
    "constraints",
    "risks",
    "openQuestions",
    "canProceed",
    "proceedReason"
  ],
  additionalProperties: false
}

const EXPLORE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    relevantFiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          suggestedUse: { type: "string" }
        },
        required: ["path", "reason", "suggestedUse"],
        additionalProperties: false
      }
    },
    testCommands: { type: "array", items: { type: "string" } },
    buildCommands: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "relevantFiles", "testCommands", "buildCommands", "risks"],
  additionalProperties: false
}

const TASK_PLAN_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string" },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          why: { type: "string" },
          targetFiles: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" }, minItems: 1 },
          validationCommands: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: [
          "id",
          "title",
          "objective",
          "why",
          "targetFiles",
          "acceptanceCriteria",
          "validationCommands",
          "dependencies",
          "riskLevel"
        ],
        additionalProperties: false
      }
    },
    globalValidationCommands: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    canImplement: { type: "boolean" }
  },
  required: ["strategy", "tasks", "globalValidationCommands", "blockers", "canImplement"],
  additionalProperties: false
}

const IMPLEMENTATION_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["changed", "no_change_needed", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    commandsRun: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary", "changedFiles", "commandsRun", "blockers", "notes"],
  additionalProperties: false
}

const VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "fail", "blocked", "not_run"] },
    summary: { type: "string" },
    commandChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "not_run"] },
          evidence: { type: "string" }
        },
        required: ["command", "result", "evidence"],
        additionalProperties: false
      }
    },
    acceptanceChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          criterion: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "unclear"] },
          evidence: { type: "string" }
        },
        required: ["id", "criterion", "result", "evidence"],
        additionalProperties: false
      }
    },
    issues: { type: "array", items: { type: "string" } },
    recommendedFixes: { type: "array", items: { type: "string" } }
  },
  required: [
    "status",
    "summary",
    "commandChecks",
    "acceptanceChecks",
    "issues",
    "recommendedFixes"
  ],
  additionalProperties: false
}

const FINAL_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ready", "needs_fix", "blocked"] },
    summary: { type: "string" },
    acceptanceCoverage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          criterion: { type: "string" },
          status: { type: "string", enum: ["covered", "not_covered", "unclear"] },
          evidence: { type: "string" }
        },
        required: ["id", "criterion", "status", "evidence"],
        additionalProperties: false
      }
    },
    commandChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "not_run"] },
          evidence: { type: "string" }
        },
        required: ["command", "result", "evidence"],
        additionalProperties: false
      }
    },
    releaseNotes: { type: "array", items: { type: "string" } },
    remainingIssues: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } }
  },
  required: [
    "verdict",
    "summary",
    "acceptanceCoverage",
    "commandChecks",
    "releaseNotes",
    "remainingIssues",
    "nextActions"
  ],
  additionalProperties: false
}

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function asRequirement(value) {
  if (typeof value === "string") return value.trim()
  if (!value || typeof value !== "object") return value == null ? "" : String(value).trim()
  // 对象形式必须显式携带需求字段;只传选项(如 { artifactDir, resume })时返回空串
  // 以触发"缺少需求"报错,而不是把选项 JSON 当需求去实现。
  const candidate =
    value.requirement ?? value.need ?? value.task ?? value.description ?? value.prompt
  return typeof candidate === "string" ? candidate.trim() : ""
}

function argObject() {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {}
}

function joinPath(dir, file) {
  return dir.replace(/\/+$/g, "") + "/" + file.replace(/^\/+/g, "")
}

function slugify(value) {
  const base = String(value || "requirement")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return base || "requirement"
}

function normalizeTaskId(value, index) {
  const base = slugify(value || `task-${index + 1}`).slice(0, 48)
  return base || `task-${index + 1}`
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  // 预算类参数必须取整:1.5 轮/1.5 个任务会让 < 比较多跑一轮/一个。
  return Math.floor(Math.max(min, Math.min(parsed, max)))
}

function assignStableTaskIds(tasks) {
  const seen = Object.create(null)
  const idMap = Object.create(null)
  const droppedDeps = []
  const withIds = tasks.map((task, index) => {
    const raw = normalizeTaskId(task.id || task.title, index)
    let id = raw
    let suffix = 2
    while (seen[id]) {
      id = raw + "-" + suffix
      suffix += 1
    }
    seen[id] = true
    if (typeof task.id === "string" && task.id) idMap[task.id] = id
    // 规划代理常用任务标题引用依赖(dependencies: ["数据库迁移"]),标题与
    // 标题 slug 都映射到规范 id,避免依赖静默断链、拓扑失去约束。
    if (typeof task.title === "string" && task.title) {
      if (!idMap[task.title]) idMap[task.title] = id
      const titleSlug = normalizeTaskId(task.title, index)
      if (!idMap[titleSlug]) idMap[titleSlug] = id
    }
    idMap[id] = id
    return { ...task, id }
  })
  const remapped = withIds.map((task) => {
    const dependencies = []
    for (const dep of task.dependencies || []) {
      const mapped = idMap[dep] || idMap[normalizeTaskId(dep, 0)]
      if (mapped && mapped !== task.id) {
        if (!dependencies.includes(mapped)) dependencies.push(mapped)
      } else if (!mapped) {
        droppedDeps.push(`${task.id} -> ${dep}`)
      }
    }
    return { ...task, dependencies }
  })
  return { tasks: remapped, droppedDeps }
}

function topoSortTasks(tasks) {
  const byId = Object.create(null)
  for (const task of tasks) byId[task.id] = task
  const visited = Object.create(null)
  const visiting = Object.create(null)
  const ordered = []
  let cyclic = false
  function visit(task) {
    if (visited[task.id]) return
    if (visiting[task.id]) {
      cyclic = true
      return
    }
    visiting[task.id] = true
    for (const dep of task.dependencies || []) {
      if (byId[dep]) visit(byId[dep])
    }
    visiting[task.id] = false
    visited[task.id] = true
    ordered.push(task)
  }
  for (const task of tasks) visit(task)
  return { tasks: ordered, cyclic }
}

function lines(items) {
  if (!items || items.length === 0) return "- 无"
  return items.map((item) => `- ${item}`).join("\n")
}

function uniq(items) {
  // 原型无关字典:命令文本作 key,普通 {} 会让 "__proto__"/"toString" 这类
  // key 读到继承属性——uniq 里表现为静默丢弃合法条目(门禁变松方向)。
  const seen = Object.create(null)
  const out = []
  for (const item of items || []) {
    if (typeof item !== "string" || item.length === 0) continue
    if (seen[item]) continue
    seen[item] = true
    out.push(item)
  }
  return out
}

// 命令文本归一化:吸收空白漂移(trim + 连续空白折叠为单空格)。已知取舍:
// 折叠不感知 shell 引号,`grep "a  b"` 与 `grep "a b"` 会被判等——声明命令
// 里引号内多空格有语义的场景极罕见,换 shell-aware 解析不值当。验证代理仍须
// 原样回填声明命令(prompt 有此要求),归一化只兜底空格/换行差异的误判。
function normalizeCommandText(cmd) {
  return String(cmd || "")
    .trim()
    .replace(/\s+/g, " ")
}

function take(items, limit) {
  return (items || []).slice(0, limit)
}

function statusText(value) {
  const labels = {
    planned: "已规划",
    skipped: "已跳过",
    changed: "已修改",
    no_change_needed: "无需修改",
    blocked: "已阻塞",
    pass: "通过",
    fail: "失败",
    not_run: "未运行",
    ready: "可交付",
    needs_fix: "需要修复",
    in_progress: "进行中",
    done: "已完成"
  }
  return labels[value] || value || "未知"
}

let fatalGlobError = null

async function safeGlob(pattern) {
  try {
    return await glob(pattern)
  } catch (error) {
    const message = String((error && error.message) || error)
    if (/matched more than/.test(message)) {
      // 引擎的 glob 结果上限是保护性错误:吞掉它会让脚本在几乎没有文件清单的
      // 情况下继续规划实现。parallel 会把 thunk 异常吞成 null,直接 throw 传
      // 不到主流程——记录标志,收集结束后统一 throwIfGlobOverflow 快速失败。
      fatalGlobError = `glob("${pattern}") 超出引擎结果上限,请缩小匹配范围后重试:${message}`
      return []
    }
    log(`文件匹配失败，已跳过：${pattern}：${message}`)
    return []
  }
}

function throwIfGlobOverflow() {
  if (fatalGlobError) throw new Error(fatalGlobError)
}

async function safeRead(path) {
  try {
    return await readFile(path)
  } catch (_error) {
    return null
  }
}

async function readJson(path) {
  const text = await safeRead(path)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function taskDir(root, task) {
  return joinPath(root, "tasks/" + task.id)
}

function taskArtifacts(root, task) {
  const dir = taskDir(root, task)
  return {
    dir,
    contract: joinPath(dir, "任务契约.md"),
    state: joinPath(dir, "任务状态.json"),
    implementation: joinPath(dir, "实现报告.md"),
    verification: joinPath(dir, "验证报告.md"),
    fix: joinPath(dir, "修复报告.md")
  }
}

function renderState(data) {
  return stringify({
    version: WORKFLOW_VERSION,
    mode: "auto-dev-harness",
    checkpoint: data.checkpoint,
    title: data.normalized ? data.normalized.title : "",
    normalized: data.normalized || null,
    exploration: data.exploration || null,
    plan: data.plan || null,
    artifactDir: data.artifactDir,
    outputPath: data.outputPath,
    requirement: data.requirement,
    artifacts: data.artifacts,
    tasks: data.tasks || [],
    stats: data.stats || {},
    summary: data.summary || "",
    blockers: data.blockers || []
  })
}

async function writeState(context, checkpoint, summary, blockers) {
  const nextState = {
    checkpoint,
    normalized: context.normalized,
    exploration: context.exploration || null,
    plan: context.plan || null,
    artifactDir: context.artifactDir,
    outputPath: context.outputPath,
    requirement: context.requirement,
    artifacts: context.artifacts,
    tasks: context.taskStates,
    stats: context.stats,
    summary,
    blockers: blockers || []
  }
  await writeFile(context.artifacts.state, renderState(nextState))
}

function renderRequirementDoc(normalized, rawRequirement) {
  return `# 需求契约

## 标题

${normalized.title}

## 原始需求

${rawRequirement}

## 问题背景

${normalized.problem}

## 目标

${normalized.goal}

## 非目标

${lines(normalized.nonGoals)}

## 验收标准

${lines(normalized.acceptanceCriteria)}

## 约束

${lines(normalized.constraints)}

## 风险

${lines(normalized.risks)}

## 待确认项

${lines(normalized.openQuestions)}

## 是否可以继续

${normalized.canProceed ? "可以继续" : "已阻塞"}：${normalized.proceedReason}
`
}

function renderProjectProfile(exploration, stats) {
  return `# 项目画像

## 摘要

${exploration.summary}

## 相关文件

${
  (exploration.relevantFiles || [])
    .map((file) => `- ${file.path}：${file.reason}；用途：${file.suggestedUse}`)
    .join("\n") || "- 无"
}

## 构建命令

${lines(exploration.buildCommands)}

## 测试命令

${lines(exploration.testCommands)}

## 风险

${lines(exploration.risks)}

## 扫描统计

\`\`\`json
${stringify(stats)}
\`\`\`
`
}

function renderTaskPlan(plan) {
  return `# 任务规划

## 总体策略

${plan.strategy}

## 全局验证命令

${lines(plan.globalValidationCommands)}

## 阻塞项

${lines(plan.blockers)}

## 任务清单

${plan.tasks
  .map(
    (task, index) => `### ${index + 1}. ${task.title}

- ID：\`${task.id}\`
- 目标：${task.objective}
- 原因：${task.why}
- 风险：${task.riskLevel}
- 依赖：${task.dependencies.length ? task.dependencies.join(", ") : "无"}
- 目标文件：${task.targetFiles.length ? task.targetFiles.join(", ") : "待实现时确认"}

验收标准：
${lines(task.acceptanceCriteria)}

验证命令：
${lines(task.validationCommands)}
`
  )
  .join("\n")}
`
}

function renderTaskContract(task, normalized) {
  return `# 任务契约：${task.title}

## 任务 ID

\`${task.id}\`

## 总需求

${normalized.title}

## 任务目标

${task.objective}

## 为什么需要这个任务

${task.why}

## 目标文件

${lines(task.targetFiles)}

## 验收标准

${lines(task.acceptanceCriteria)}

## 验证命令

${lines(task.validationCommands)}

## 依赖任务

${lines(task.dependencies)}
`
}

function renderImplementationDoc(task, implementation, fix) {
  return `# 实现报告：${task.title}

## 首轮实现

**状态：** ${statusText(implementation.status)}

${implementation.summary}

### 变更文件

${lines(implementation.changedFiles)}

### 执行命令

${lines(implementation.commandsRun)}

### 阻塞项

${lines(implementation.blockers)}

### 备注

${lines(implementation.notes)}

## 修复轮次

${
  fix
    ? `**状态：** ${statusText(fix.status)}

${fix.summary}

### 变更文件

${lines(fix.changedFiles)}

### 执行命令

${lines(fix.commandsRun)}

### 阻塞项

${lines(fix.blockers)}
`
    : "未执行修复轮次。"
}
`
}

function renderVerificationDoc(task, verification, afterFix) {
  const finalVerification = afterFix || verification
  return `# 验证报告：${task.title}

## 最终验证状态

**状态：** ${statusText(finalVerification.status)}

${finalVerification.summary}

## 命令检查

${
  (finalVerification.commandChecks || [])
    .map((item) => `- \`${item.command}\`：${statusText(item.result)}。${item.evidence}`)
    .join("\n") || "- 无"
}

## 验收检查

${
  (finalVerification.acceptanceChecks || [])
    .map(
      (item) => `- ${statusText(item.result)}：[${item.id}] ${item.criterion} — ${item.evidence}`
    )
    .join("\n") || "- 无"
}

## 问题

${lines(finalVerification.issues)}

## 建议修复

${lines(finalVerification.recommendedFixes)}

${
  afterFix
    ? `## 首轮验证

**状态：** ${statusText(verification.status)}

${verification.summary}
`
    : ""
}
`
}

function renderFinalReport(context, finalReview) {
  const done = context.taskStates.filter((task) => task.status === "ready").length
  return `# 长程需求自动开发交付报告

## 总体结论

**状态：** ${statusText(finalReview.verdict)}

${finalReview.summary}

## 需求

${context.normalized.title}

## 任务进度

- 总任务数：${context.taskStates.length}
- 已通过任务数：${done}

${context.taskStates
  .map(
    (task, index) => `### ${index + 1}. ${task.title}

- ID：\`${task.id}\`
- 状态：${statusText(task.status)}
- 摘要：${task.summary || "无"}
- 变更文件：${task.changedFiles && task.changedFiles.length ? task.changedFiles.join(", ") : "无"}
- 问题：${task.issues && task.issues.length ? task.issues.join("；") : "无"}
`
  )
  .join("\n")}

## 发布说明

${lines(finalReview.releaseNotes)}

## 剩余问题

${lines(finalReview.remainingIssues)}

## 下一步

${lines(finalReview.nextActions)}

## 关键产物

- 状态文件：${context.artifacts.state}
- 需求契约：${context.artifacts.requirement}
- 项目画像：${context.artifacts.projectProfile}
- 任务规划：${context.artifacts.taskPlan}
- 总体验证：${context.artifacts.finalVerification}
- 交付报告：${context.artifacts.deliveryReport}
`
}

function mergeExploration(parts) {
  const summaries = []
  const relevantFiles = []
  const testCommands = []
  const buildCommands = []
  const risks = []
  const seenFiles = Object.create(null)

  for (const part of parts || []) {
    if (!part) continue
    if (part.summary) summaries.push(part.summary)
    for (const file of part.relevantFiles || []) {
      if (!file || !file.path || seenFiles[file.path]) continue
      seenFiles[file.path] = true
      relevantFiles.push(file)
    }
    for (const command of part.testCommands || []) testCommands.push(command)
    for (const command of part.buildCommands || []) buildCommands.push(command)
    for (const risk of part.risks || []) risks.push(risk)
  }

  return {
    summary: summaries.join("\n\n") || "没有获得项目探索摘要。",
    relevantFiles,
    testCommands: uniq(testCommands),
    buildCommands: uniq(buildCommands),
    risks: uniq(risks)
  }
}

function fallbackImplementation(summary) {
  return {
    status: "blocked",
    summary,
    changedFiles: [],
    commandsRun: [],
    blockers: [summary],
    notes: []
  }
}

function fallbackVerification(summary) {
  return {
    status: "blocked",
    summary,
    commandChecks: [],
    acceptanceChecks: [],
    issues: [summary],
    recommendedFixes: []
  }
}

// 代码层一致性门禁:总体结论是 pass 时,验收检查必须按稳定 ID(AC-1..AC-N,
// 对应任务验收标准的顺序)逐条对齐——缺失 ID、清单外 ID 凑数、措辞改写都无法
// 绕过 ID 集合;每条 pass 必须附证据,且命令检查无 fail。任一不满足即属矛盾/
// 偷懒输出,强制降为 fail,让修复循环与最终门禁正确反应。
function enforceVerificationConsistency(verification, task) {
  if (!verification || verification.status !== "pass") return verification
  const problems = []
  const expectedCriteria = (task && task.acceptanceCriteria) || []
  const expectedIds = expectedCriteria.map((_, index) => "AC-" + (index + 1))
  const checks = verification.acceptanceChecks || []
  const passedIds = new Set(
    checks
      .filter((item) => item.result === "pass" && String(item.evidence || "").trim().length > 0)
      .map((item) =>
        String(item.id || "")
          .trim()
          .toUpperCase()
      )
  )
  const missingIds = expectedIds.filter((id) => !passedIds.has(id))
  if (missingIds.length > 0) {
    problems.push(`验收检查未逐条覆盖(缺失或无有效通过证据:${missingIds.join("、")})`)
  }
  for (const item of checks) {
    if (item.result !== "pass") {
      problems.push(`验收未通过:[${item.id}] ${item.criterion}(${statusText(item.result)})`)
    }
  }
  for (const item of verification.commandChecks || []) {
    if (item.result === "fail") problems.push(`命令失败:${item.command}`)
  }
  // 任务声明的验证命令必须被执行且通过:缺失/not_run 与总体 pass 矛盾。
  // 重复上报聚合取"最坏":先 fail 后 pass 不得被覆盖。
  const reportedCmd = Object.create(null)
  for (const item of verification.commandChecks || []) {
    const key = normalizeCommandText(item.command)
    const existing = reportedCmd[key]
    if (!existing || existing.result === "pass") reportedCmd[key] = item
  }
  for (const cmd of uniq((task && task.validationCommands) || [])) {
    const entry = reportedCmd[normalizeCommandText(cmd)]
    if (!entry || entry.result !== "pass") {
      problems.push(`声明的验证命令未执行或未通过:${cmd}`)
    }
  }
  if (problems.length === 0) return verification
  return {
    ...verification,
    status: "fail",
    issues: uniq([
      ...(verification.issues || []),
      "验证结论与检查明细不符,已由代码强制降级:" + problems.join(";")
    ])
  }
}

function taskWasCompleted(taskState) {
  return taskState && taskState.status === "ready"
}

function taskStateById(states, id) {
  for (const state of states || []) {
    if (state && state.id === id) return state
  }
  return null
}

// 任务契约指纹:目标/验收标准/验证命令/目标文件/依赖任一变化即视为新契约,
// replan 后同 ID 任务的旧完成状态据此失效。
function taskContractFingerprint(task) {
  // 验收标准保持位置序(AC id 依赖位置);命令/文件/依赖语义无序,排序后入指纹,
  // 避免 replan 仅调整顺序就误判契约变化、白白重跑任务。
  const sorted = (arr) => [...(arr || [])].sort()
  return stringify([
    task.objective || "",
    task.acceptanceCriteria || [],
    sorted(task.validationCommands),
    sorted(task.targetFiles),
    sorted(task.dependencies)
  ])
}

function updateTaskState(context, task, patch) {
  const existing = taskStateById(context.taskStates, task.id)
  const next = {
    id: task.id,
    title: task.title,
    status: patch.status || (existing && existing.status) || "planned",
    summary: patch.summary || (existing && existing.summary) || "",
    changedFiles: patch.changedFiles || (existing && existing.changedFiles) || [],
    issues: patch.issues || (existing && existing.issues) || [],
    contractFingerprint:
      patch.contractFingerprint || (existing && existing.contractFingerprint) || "",
    artifactDir: taskDir(context.artifactDir, task)
  }

  if (existing) {
    for (let i = 0; i < context.taskStates.length; i++) {
      if (context.taskStates[i].id === task.id) context.taskStates[i] = next
    }
  } else {
    context.taskStates.push(next)
  }
}

async function writeTaskState(context, task, patch) {
  updateTaskState(context, task, patch)
  const artifacts = taskArtifacts(context.artifactDir, task)
  await writeFile(artifacts.state, stringify(taskStateById(context.taskStates, task.id)))
  await writeState(context, "task_running", `任务 ${task.title} 已更新。`, [])
}

const options = argObject()
const requirement = asRequirement(args)
const resumeEnabled = options.resume !== false
const replanEnabled = options.replan === true
const maxTasks = numberInRange(options.maxTasks, MAX_TASKS, 1, MAX_TASKS)
const maxFixRounds = numberInRange(options.maxFixRounds, MAX_FIX_ROUNDS, 0, MAX_FIX_ROUNDS)
const forcedTaskIds = Array.isArray(options.forceTaskIds)
  ? options.forceTaskIds.map((id) => String(id))
  : []

if (!requirement) {
  throw new Error("缺少需求内容。请传入 args.requirement，或直接传入一段需求文本。")
}

// 产物目录锚定在原始需求文本上：同一需求重跑时路径稳定，状态文件才能被找到并续跑。
const artifactDir =
  typeof options.artifactDir === "string"
    ? options.artifactDir
    : joinPath(DEFAULT_ARTIFACT_ROOT, slugify(requirement))
const outputPath =
  typeof options.outputPath === "string" ? options.outputPath : joinPath(artifactDir, "交付报告.md")
const artifacts = {
  state: joinPath(artifactDir, "状态.json"),
  requirement: joinPath(artifactDir, "需求契约.md"),
  projectProfile: joinPath(artifactDir, "项目画像.md"),
  taskPlan: joinPath(artifactDir, "任务规划.md"),
  finalVerification: joinPath(artifactDir, "总体验证.md"),
  deliveryReport: outputPath
}
const previousState = resumeEnabled ? await readJson(artifacts.state) : null
const canReuse =
  !!previousState &&
  previousState.version === WORKFLOW_VERSION &&
  // mode 校验:防止用户显式传同一个 artifactDir 时,误吞其他工作流的状态文件
  previousState.mode === "auto-dev-harness" &&
  previousState.requirement === requirement

phase("需求整理")
let normalized = null
if (canReuse && previousState.normalized && previousState.normalized.canProceed) {
  normalized = previousState.normalized
  log("续跑：复用已有需求契约。")
} else {
  normalized = await agent(
    `请把下面的开发需求整理成可执行的工程契约。

需求内容：
${requirement}

请判断是否可以在不继续询问用户的情况下安全进入后续开发。
如果缺少关键业务规则、安全边界或验收标准，请将 canProceed 设为 false。
不要编造业务规则。`,
    {
      label: "需求整理",
      phase: "需求整理",
      agentType: "Plan",
      schema: REQUIREMENT_SCHEMA
    }
  )
}

if (!normalized || !normalized.canProceed) {
  const title = normalized ? normalized.title : "需求未明确"
  const report = `# 长程需求自动开发已阻塞

## 原始需求

${requirement}

## 阻塞原因

${normalized ? normalized.proceedReason : "需求整理代理没有返回结构化结果。"}

## 待确认项

${normalized ? lines(normalized.openQuestions) : "- 需求整理失败"}
`
  await writeFile(outputPath, report)
  await writeFile(
    artifacts.state,
    renderState({
      checkpoint: "requirement_blocked",
      normalized,
      artifactDir,
      outputPath,
      requirement,
      artifacts,
      tasks: [],
      summary: normalized ? normalized.proceedReason : "需求整理失败",
      blockers: normalized ? normalized.openQuestions : ["需求整理失败"]
    })
  )
  return {
    状态: "已阻塞",
    标题: title,
    报告路径: outputPath,
    阻塞项: normalized ? normalized.openQuestions : ["需求整理失败"]
  }
}

const context = {
  normalized,
  artifactDir,
  outputPath,
  requirement,
  artifacts,
  exploration: null,
  plan: null,
  // 只有确认是同一需求的状态文件才继承任务进度，避免旧任务残留污染统计。
  taskStates: canReuse && Array.isArray(previousState.tasks) ? previousState.tasks : [],
  stats: {}
}

log("需求：" + normalized.title)
await writeFile(artifacts.requirement, renderRequirementDoc(normalized, requirement))
await writeState(context, "requirement_done", normalized.proceedReason, [])

phase("项目探索")
let exploration = null
if (canReuse && previousState.exploration) {
  exploration = previousState.exploration
  context.stats = previousState.stats || {}
  log("续跑：复用已有项目画像。")
} else {
  const manifestPatterns = [
    "AGENTS.md",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "Makefile"
  ]
  const sourcePatterns = [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.js",
    "src/**/*.jsx",
    "src/**/*.java",
    "src/**/*.go",
    "src/**/*.py",
    "src/**/*.rs",
    "src/**/*.vue",
    "app/**/*.ts",
    "app/**/*.tsx",
    "test/**/*",
    "tests/**/*",
    "__tests__/**/*"
  ]
  const manifests = uniq((await parallel(manifestPatterns.map((p) => () => safeGlob(p)))).flat())
  const sourceFiles = uniq((await parallel(sourcePatterns.map((p) => () => safeGlob(p)))).flat())
  throwIfGlobOverflow()
  const manifestSnippets = []
  for (const file of take(manifests, MAX_MANIFESTS)) {
    const content = await safeRead(file)
    if (content) manifestSnippets.push(`--- ${file} ---\n${content.slice(0, 6000)}`)
  }
  const inventory = take(sourceFiles, MAX_SOURCE_FILES)
  const explorePrompts = [
    {
      label: "架构",
      prompt: "识别项目类型、关键模块、需求最可能影响的文件，以及实现入口。"
    },
    {
      label: "验证",
      prompt: "识别可用构建/测试/lint 命令、测试目录、现有验证习惯和风险。"
    },
    {
      label: "风险",
      prompt: "识别兼容性、安全、数据、配置、发布和回滚风险。"
    }
  ]
  const explorationParts = (
    await parallel(
      explorePrompts.map(
        (item) => () =>
          agent(
            `请只读探索项目，不要修改文件。

探索视角：${item.label}
${item.prompt}

需求契约：
${stringify(normalized)}

配置/说明文件片段：
${manifestSnippets.join("\n\n") || "未找到"}

候选源码/测试文件列表（已截断）：
${lines(inventory)}

请返回相关文件、命令和风险。`,
            {
              label: "探索：" + item.label,
              phase: "项目探索",
              agentType: "Explore",
              schema: EXPLORE_SCHEMA
            }
          )
      )
    )
  ).filter(Boolean)
  exploration = mergeExploration(explorationParts)
  context.stats = {
    manifests: manifests.length,
    sourceFiles: sourceFiles.length,
    explorationParts: explorationParts.length
  }
}
context.exploration = exploration
await writeFile(artifacts.projectProfile, renderProjectProfile(exploration, context.stats))
await writeState(context, "explore_done", "项目探索已完成。", [])

phase("任务规划")
let plan = null
if (canReuse && !replanEnabled && previousState.plan && previousState.plan.canImplement) {
  plan = previousState.plan
  log("续跑：复用已有任务规划（如需重新规划请传 replan: true）。")
} else {
  plan = await agent(
    `请把需求拆成可执行任务清单。任务粒度要小到一个 agent 可以安全完成。

需求契约：
${stringify(normalized)}

项目画像：
${stringify(exploration)}

已有状态（如果是续跑，请尽量复用已有任务 ID，避免已完成任务无法跳过）：
${previousState ? stringify(previousState.tasks || []) : "无"}

要求：
- 按需求完整拆分任务,数量以需求本身为准,不要为凑数或省略而增删;本次运行最多执行 ${maxTasks} 个未完成任务,超出的会自动留待续跑分批执行。
- 每个任务都要有明确验收标准和验证命令。
- 任务之间如果有依赖，请写 dependencies。
- 任务 id 必须稳定、简短、kebab-case；续跑时尽量保留已有 id。
- 如果无法安全实现，将 canImplement 设为 false 并列出 blockers。`,
    {
      label: "任务规划",
      phase: "任务规划",
      agentType: "Plan",
      schema: TASK_PLAN_SCHEMA
    }
  )

  if (!plan || !plan.canImplement) {
    const blockers = plan ? plan.blockers : ["任务规划代理没有返回结构化结果。"]
    await writeState(context, "plan_blocked", "任务规划已阻塞。", blockers)
    await writeFile(
      artifacts.deliveryReport,
      `# 长程需求自动开发已阻塞

## 需求

${stringify(normalized)}

## 阻塞项

${lines(blockers)}
`
    )
    return {
      状态: "已阻塞",
      报告路径: artifacts.deliveryReport,
      阻塞项: blockers
    }
  }

  const assigned = assignStableTaskIds(plan.tasks)
  if (assigned.droppedDeps.length > 0) {
    log("已忽略无法解析的任务依赖：" + assigned.droppedDeps.join("；"))
  }
  // 拓扑排序完整任务图。注意:不截断计划——maxTasks 是"单次运行的执行预算",
  // 超出预算的任务保持 planned 留给续跑分批执行。截断会让被丢任务从状态中
  // 消失,最终门禁看不见它们,可能"部分完成却报可交付"。
  const sorted = topoSortTasks(assigned.tasks)
  if (sorted.cyclic) {
    log("任务依赖存在环，无法完全拓扑排序，按可行顺序执行。")
  }
  plan.tasks = sorted.tasks

  // 新计划生效(含 replan:true):清掉不在新计划里的旧任务状态。
  // 保留 id 相同的已完成任务(仍可跳过),丢弃孤儿,避免污染报告统计与总体验证。
  const planTaskIds = Object.create(null)
  for (const task of plan.tasks) planTaskIds[task.id] = true
  const staleTasks = context.taskStates.filter((t) => !planTaskIds[t.id])
  if (staleTasks.length > 0) {
    log("新计划不包含以下旧任务,其状态已移除:" + staleTasks.map((t) => t.id).join("、"))
    context.taskStates = context.taskStates.filter((t) => planTaskIds[t.id])
  }
}
context.plan = plan
await writeFile(artifacts.taskPlan, renderTaskPlan(plan))
for (const task of plan.tasks) {
  const existing = taskStateById(context.taskStates, task.id)
  const fingerprint = taskContractFingerprint(task)
  if (!existing) {
    updateTaskState(context, task, {
      status: "planned",
      summary: "任务已规划。",
      changedFiles: [],
      issues: [],
      contractFingerprint: fingerprint
    })
  } else if (existing.contractFingerprint && existing.contractFingerprint !== fingerprint) {
    // 同 ID 但契约(目标/验收标准/验证命令/依赖)已变化:旧完成状态不再可信,
    // 强制失效重新执行——防止 replan 后基于旧结果虚报"可交付"。
    log(`任务 ${task.id} 的契约已变化,旧状态失效,将重新执行。`)
    updateTaskState(context, task, {
      status: "planned",
      summary: "任务契约已变化,待重新执行。",
      changedFiles: [],
      issues: [],
      contractFingerprint: fingerprint
    })
  } else {
    updateTaskState(context, task, { contractFingerprint: fingerprint })
  }
}
await writeState(context, "plan_done", "任务规划已完成。", [])

// forceTaskIds 的传递失效:被强制重跑的任务可能改变接口/行为,依赖它的已完成
// 任务结果不再可信——沿依赖图向下游传递,连带重跑(执行顺序是拓扑序,上游先跑)。
// forceTaskIds 输入归一化:任务 id 在规划时会被 slugify("Task A"→"task-a"),
// 用户原样输入必须映射到规范化 id,也支持按任务标题(大小写不敏感)反查;
// 无法匹配的输入显式告警,绝不静默失效。
const effectiveForcedIds = new Set()
const unmatchedForcedInputs = []
for (const raw of forcedTaskIds) {
  const normalizedInput = normalizeTaskId(raw, 0)
  const match = plan.tasks.find(
    (task) =>
      task.id === raw ||
      task.id === normalizedInput ||
      String(task.title || "")
        .trim()
        .toLowerCase() === raw.trim().toLowerCase()
  )
  if (match) {
    effectiveForcedIds.add(match.id)
  } else {
    unmatchedForcedInputs.push(raw)
  }
}
if (unmatchedForcedInputs.length > 0) {
  log(`forceTaskIds 中无法匹配任何计划任务的输入已忽略:${unmatchedForcedInputs.join("、")}`)
}
if (effectiveForcedIds.size > 0) {
  const directlyForcedIds = new Set(effectiveForcedIds)
  let grew = true
  while (grew) {
    grew = false
    for (const task of plan.tasks) {
      if (effectiveForcedIds.has(task.id)) continue
      if ((task.dependencies || []).some((dep) => effectiveForcedIds.has(dep))) {
        effectiveForcedIds.add(task.id)
        grew = true
      }
    }
  }
  const cascaded = [...effectiveForcedIds].filter((id) => !directlyForcedIds.has(id))
  if (cascaded.length > 0) {
    log(`强制重跑沿依赖传递,以下下游任务将连带重跑:${cascaded.join("、")}`)
  }
  // 立即把强制集合的旧状态失效为 planned:否则预算截断在下游执行前 break 时,
  // 下游仍挂着旧 ready,最终门禁会把"被强制但本轮未执行"的任务误当完成放行。
  for (const forcedId of effectiveForcedIds) {
    const state = taskStateById(context.taskStates, forcedId)
    if (state && state.status === "ready") {
      const forcedTask = plan.tasks.find((t) => t.id === forcedId)
      if (forcedTask) {
        updateTaskState(context, forcedTask, {
          status: "planned",
          summary: "强制重跑,待执行。",
          changedFiles: [],
          issues: []
        })
      }
    }
  }
}

phase("任务执行")
let executedThisRun = 0
for (let index = 0; index < plan.tasks.length; index++) {
  const task = plan.tasks[index]
  const existing = taskStateById(context.taskStates, task.id)
  const forced = effectiveForcedIds.has(task.id)
  if (resumeEnabled && !forced && taskWasCompleted(existing)) {
    log(`跳过已完成任务：${task.title}`)
    continue
  }
  if (executedThisRun >= maxTasks) {
    const remaining = plan.tasks
      .slice(index)
      .filter((t) => !taskWasCompleted(taskStateById(context.taskStates, t.id)))
      .map((t) => t.id)
    log(
      `本次运行任务预算已用尽(maxTasks=${maxTasks}),剩余任务保持待办留给续跑:${remaining.join("、")}`
    )
    break
  }

  const unmetDeps = (task.dependencies || []).filter((dep) => {
    const depState = taskStateById(context.taskStates, dep)
    return !depState || depState.status !== "ready"
  })
  if (unmetDeps.length > 0) {
    const reason = "依赖任务未就绪：" + unmetDeps.join("、")
    log(`任务 ${task.title} 已阻塞：${reason}`)
    await writeTaskState(context, task, {
      status: "blocked",
      summary: reason,
      changedFiles: [],
      issues: [reason]
    })
    continue
  }

  const taskFiles = taskArtifacts(artifactDir, task)
  await writeFile(taskFiles.contract, renderTaskContract(task, normalized))
  executedThisRun += 1
  await writeTaskState(context, task, {
    status: "in_progress",
    summary: "任务开始执行。",
    changedFiles: [],
    issues: []
  })

  const implementation =
    (await agent(
      `请实现当前任务。只处理这个任务，不要扩大范围。

总需求：
${stringify(normalized)}

整体策略：
${plan.strategy}

项目画像：
${stringify(exploration)}

当前任务：
${stringify(task)}

任务契约文件：${taskFiles.contract}

执行要求：
- 做最小且正确的修改。
- 如果任务依赖前序变更，请读取相关文件确认当前状态。
- 变更后尽量运行任务相关验证命令。
- 如果无法安全完成，返回 status=blocked 并列出阻塞项。`,
      {
        label: `实现：${task.title}`,
        phase: "任务执行",
        schema: IMPLEMENTATION_SCHEMA
      }
    )) || fallbackImplementation("实现代理没有返回结构化结果。")

  let verification =
    implementation.status === "blocked"
      ? fallbackVerification("实现阶段已阻塞，因此未运行验证。")
      : enforceVerificationConsistency(
          (await agent(
            `请验证当前任务的实现结果。不要修改文件。

总需求：
${stringify(normalized)}

当前任务：
${stringify(task)}

实现结果：
${stringify(implementation)}

建议验证命令：
${lines(task.validationCommands)}

验收标准清单（acceptanceChecks 必须按下面的 id 逐条返回,不得遗漏、不得使用清单外的 id,不允许合并）：
${(task.acceptanceCriteria || []).map((text, i) => `- AC-${i + 1}: ${text}`).join("\n")}

请实际运行可用的命令，并尝试至少一个边界/反例。每条检查给出结论与证据。
声明命令必须按原样执行(不得加参数/前缀窄化其范围——门禁按 commandChecks.command 裁决,窄化执行等同虚报),commandChecks.command 原样填写声明的命令字符串并逐条报告;确需额外命令另行执行、作为额外条目如实报告。`,
            {
              label: `验证：${task.title}`,
              phase: "任务执行",
              agentType: "verification",
              schema: VERIFICATION_SCHEMA
            }
          )) || fallbackVerification("验证代理没有返回结构化结果。"),
          task
        )

  const firstVerification = verification
  let fix = null
  let fixRound = 0
  while (
    verification &&
    verification.status === "fail" &&
    implementation.status !== "blocked" &&
    fixRound < maxFixRounds
  ) {
    fixRound += 1
    const previousFix = fix
    fix =
      (await agent(
        `请根据验证失败结果执行第 ${fixRound} 轮聚焦修复。只修复当前任务，不要扩大范围。

总需求：
${stringify(normalized)}

当前任务：
${stringify(task)}

首轮实现：
${stringify(implementation)}
${
  previousFix
    ? `
上一轮修复（当前代码已包含这些修改）：
${stringify(previousFix)}
`
    : ""
}
最新验证失败：
${stringify(verification)}

如果无法安全修复，返回 status=blocked。`,
        {
          label: `修复：${task.title} #${fixRound}`,
          phase: "任务执行",
          schema: IMPLEMENTATION_SCHEMA
        }
      )) || fallbackImplementation("修复代理没有返回结构化结果。")

    if (fix.status === "blocked") break

    verification = enforceVerificationConsistency(
      (await agent(
        `请验证第 ${fixRound} 轮修复后的当前任务。不要修改文件。

当前任务：
${stringify(task)}

首轮实现：
${stringify(implementation)}

修复结果：
${stringify(fix)}

上一次验证：
${stringify(verification)}

验收标准清单（acceptanceChecks 必须按下面的 id 逐条返回,不得遗漏、不得使用清单外的 id,不允许合并）：
${(task.acceptanceCriteria || []).map((text, i) => `- AC-${i + 1}: ${text}`).join("\n")}

任务声明的验证命令必须逐条执行并逐条报告,commandChecks.command 原样填写声明的命令字符串;acceptanceChecks 仍须按 id 逐条覆盖全部验收标准。`,
        {
          label: `复验：${task.title} #${fixRound}`,
          phase: "任务执行",
          agentType: "verification",
          schema: VERIFICATION_SCHEMA
        }
      )) || fallbackVerification("修复后验证代理没有返回结构化结果。"),
      task
    )
  }

  const finalImplementation = fix || implementation
  const finalStatus =
    finalImplementation.status === "blocked"
      ? "blocked"
      : verification.status === "pass"
        ? "ready"
        : verification.status === "blocked"
          ? "blocked"
          : "needs_fix"
  const issues = uniq([...(verification.issues || []), ...(finalImplementation.blockers || [])])
  const changedFiles = uniq([
    ...(implementation.changedFiles || []),
    ...((fix && fix.changedFiles) || [])
  ])

  await writeFile(taskFiles.implementation, renderImplementationDoc(task, implementation, fix))
  await writeFile(
    taskFiles.verification,
    renderVerificationDoc(
      task,
      firstVerification,
      verification !== firstVerification ? verification : null
    )
  )
  if (fix) {
    await writeFile(taskFiles.fix, renderImplementationDoc(task, fix, null))
  }
  await writeTaskState(context, task, {
    status: finalStatus,
    summary: verification.summary || finalImplementation.summary,
    changedFiles,
    issues
  })
}

phase("总体验证")
const allChangedFiles = take(
  uniq(context.taskStates.flatMap((task) => task.changedFiles || [])),
  MAX_CHANGED_FILES
)
const finalReview = (await agent(
  `请对整个需求进行最终验收。不要修改文件。

需求契约：
${stringify(normalized)}

任务规划：
${stringify(plan)}

任务状态：
${stringify(context.taskStates)}

全局建议验证命令：
${lines(plan.globalValidationCommands)}

变更文件：
${lines(allChangedFiles)}

需求验收标准清单（acceptanceCoverage 必须按下面的 id 逐条返回,不得遗漏、不得使用清单外的 id）：
${(normalized.acceptanceCriteria || []).map((text, i) => `- AC-${i + 1}: ${text}`).join("\n")}

请实际运行全局验证命令，确认所有任务合并后是否满足需求。
commandChecks 必须逐条覆盖上面列出的每一条全局验证命令,command 字段原样填写清单中的命令字符串,如实报告结果(以退出码为准),不得遗漏。`,
  {
    label: "总体验收",
    phase: "总体验证",
    agentType: "verification",
    schema: FINAL_REVIEW_SCHEMA
  }
)) || {
  verdict: "blocked",
  summary: "总体验证代理没有返回结构化结果。",
  acceptanceCoverage: [],
  commandChecks: [],
  releaseNotes: [],
  remainingIssues: ["总体验证失败。"],
  nextActions: ["查看工作流运行历史，修复失败任务后重新运行。"]
}

phase("交付报告")
// 硬门禁:"可交付"不能只信总体验收代理的一句 ready——完整性由代码强制:
// 1) 所有任务必须 ready;2) 全局验证命令必须逐条被执行且通过(缺失/失败/未跑
// 都按不通过计,与 contract-delivery 终审的交叉核对同构)。任一不满足即降级。
const unfinishedTasks = context.taskStates.filter((task) => task.status !== "ready")
const expectedGlobalCommands = uniq(plan.globalValidationCommands || [])
const reportedGlobalCommands = Object.create(null)
for (const item of finalReview.commandChecks || []) {
  const key = normalizeCommandText(item.command)
  const existing = reportedGlobalCommands[key]
  // 重复上报聚合取"最坏":失败/未跑不被后续 pass 覆盖。
  if (!existing || existing.result === "pass") reportedGlobalCommands[key] = item
}
const failedGlobalCommands = expectedGlobalCommands.filter((cmd) => {
  const entry = reportedGlobalCommands[normalizeCommandText(cmd)]
  return !entry || entry.result !== "pass"
})
// 终审代理如实报告的"清单外失败命令"同样不可忽略——它发现了问题就不能放行。
const expectedGlobalNormalized = expectedGlobalCommands.map(normalizeCommandText)
const extraFailedCommands = (finalReview.commandChecks || [])
  .filter(
    (item) =>
      item.result === "fail" &&
      !expectedGlobalNormalized.includes(normalizeCommandText(item.command))
  )
  .map((item) => item.command)
// 需求级验收覆盖按稳定 ID 对齐(与轻量版/契约版同构):规划遗漏或验收未覆盖的
// 需求标准不能靠"任务都 ready"混过最终门禁。
const expectedReqIds = (normalized.acceptanceCriteria || []).map((_, index) => "AC-" + (index + 1))
const coveredReqIds = new Set(
  (finalReview.acceptanceCoverage || [])
    .filter((item) => item.status === "covered" && String(item.evidence || "").trim().length > 0)
    .map((item) =>
      String(item.id || "")
        .trim()
        .toUpperCase()
    )
)
const missingReqIds = expectedReqIds.filter((id) => !coveredReqIds.has(id))
if (
  finalReview.verdict === "ready" &&
  (unfinishedTasks.length > 0 ||
    context.taskStates.length === 0 ||
    failedGlobalCommands.length > 0 ||
    extraFailedCommands.length > 0 ||
    missingReqIds.length > 0)
) {
  const reasons = []
  if (context.taskStates.length === 0) {
    reasons.push("没有任何任务被执行")
  } else if (unfinishedTasks.length > 0) {
    reasons.push(
      "存在未完成任务：" +
        unfinishedTasks.map((task) => `${task.id}（${statusText(task.status)}）`).join("、")
    )
  }
  if (failedGlobalCommands.length > 0) {
    reasons.push(`全局验证命令未通过或未执行：${failedGlobalCommands.join("、")}`)
  }
  if (extraFailedCommands.length > 0) {
    reasons.push(`终审额外报告了失败命令：${extraFailedCommands.join("、")}`)
  }
  if (missingReqIds.length > 0) {
    reasons.push(`需求验收标准未覆盖或证据缺失：${missingReqIds.join("、")}`)
  }
  const reason = reasons.join("；")
  log(`总体验收结论 ready 被硬门禁降级为 needs_fix：${reason}`)
  finalReview.verdict = "needs_fix"
  // 同步改写 summary/nextActions,避免报告结论是 needs_fix 而正文仍是"可交付"口吻。
  finalReview.summary = `【硬门禁降级】${reason}。原总体验收结论（仅供参考）：${finalReview.summary}`
  finalReview.remainingIssues = uniq([...(finalReview.remainingIssues || []), reason])
  finalReview.nextActions = uniq([
    ...(finalReview.nextActions || []),
    "处理未完成任务后,用同一需求文本重跑即可续跑(已完成任务会跳过)。"
  ])
}
await writeFile(artifacts.finalVerification, stringify(finalReview))
await writeFile(artifacts.deliveryReport, renderFinalReport(context, finalReview))
await writeState(
  context,
  // blocked 与 needs_fix 分开落账(镜像 requirement_blocked 先例):checkpoint
  // 是只写标签、resume 走任务账本,但排障/UI 不该把"等人工介入"误读成
  // "普通需要修复"。
  finalReview.verdict === "ready"
    ? "verify_done"
    : finalReview.verdict === "blocked"
      ? "verify_blocked"
      : "needs_fix",
  finalReview.summary,
  finalReview.remainingIssues
)

return {
  状态: statusText(finalReview.verdict),
  标题: normalized.title,
  报告路径: artifacts.deliveryReport,
  产物目录: artifactDir,
  状态文件: artifacts.state,
  任务数: context.taskStates.length,
  已完成任务数: context.taskStates.filter((task) => task.status === "ready").length,
  变更文件: allChangedFiles,
  剩余问题: finalReview.remainingIssues,
  下一步: finalReview.nextActions
}
