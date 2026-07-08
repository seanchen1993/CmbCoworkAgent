export const meta = {
  name: "需求自动开发流程",
  description: "把明确需求自动推进为影响分析、实现计划、代码修改、验证和交付报告。",
  whenToUse: "当用户已经给出较明确的开发需求，并希望自动完成后续工程步骤时使用。",
  phases: [
    { title: "需求整理" },
    { title: "项目探索" },
    { title: "实现计划" },
    { title: "代码实现" },
    { title: "验证" },
    { title: "最终复核" },
    { title: "写入报告" }
  ]
}

const MAX_MANIFESTS = 12
const MAX_SOURCE_FILES = 350
const MAX_CHANGED_FILES = 80
const EXPLORE_LENSES = [
  {
    label: "架构",
    prompt: "梳理仓库架构，并找出最可能受需求影响的文件和模块。"
  },
  {
    label: "测试",
    prompt: "查找现有测试模式、可能的验证命令，以及与需求相关的测试文件。"
  },
  {
    label: "风险",
    prompt: "检查兼容性、安全、数据、接口和发布风险，判断需求实现是否存在隐患。"
  }
]

const REQUIREMENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    problem: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    scope: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" }, minItems: 1 },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    canProceed: { type: "boolean" },
    proceedReason: { type: "string" }
  },
  required: [
    "title",
    "problem",
    "goal",
    "scope",
    "acceptanceCriteria",
    "constraints",
    "unknowns",
    "canProceed",
    "proceedReason"
  ],
  additionalProperties: false
}

const EXPLORE_SCHEMA = {
  type: "object",
  properties: {
    architectureSummary: { type: "string" },
    relevantFiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          expectedChange: { type: "string" }
        },
        required: ["path", "reason", "expectedChange"],
        additionalProperties: false
      }
    },
    risks: { type: "array", items: { type: "string" } },
    suggestedTestCommands: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: [
    "architectureSummary",
    "relevantFiles",
    "risks",
    "suggestedTestCommands",
    "confidence"
  ],
  additionalProperties: false
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    approach: { type: "string" },
    steps: { type: "array", items: { type: "string" }, minItems: 1 },
    targetFiles: { type: "array", items: { type: "string" } },
    testCommands: { type: "array", items: { type: "string" } },
    needsHumanDecision: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } },
    rollbackPlan: { type: "string" }
  },
  required: [
    "approach",
    "steps",
    "targetFiles",
    "testCommands",
    "needsHumanDecision",
    "blockers",
    "rollbackPlan"
  ],
  additionalProperties: false
}

const IMPLEMENTATION_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["changed", "blocked", "no_change_needed"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    testsRun: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary", "changedFiles", "testsRun", "blockers", "followUps"],
  additionalProperties: false
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "fail", "blocked", "not_run"] },
    summary: { type: "string" },
    commands: {
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
    issues: { type: "array", items: { type: "string" } },
    recommendedFixes: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary", "commands", "issues", "recommendedFixes"],
  additionalProperties: false
}

const REVIEW_SCHEMA = {
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
    issues: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } }
  },
  required: ["verdict", "summary", "acceptanceCoverage", "issues", "nextActions"],
  additionalProperties: false
}

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function emptyText() {
  return "- 无"
}

function statusText(value) {
  const labels = {
    changed: "已修改",
    blocked: "已阻塞",
    no_change_needed: "无需修改",
    pass: "通过",
    fail: "失败",
    not_run: "未运行",
    ready: "可交付",
    needs_fix: "需要修复",
    covered: "已覆盖",
    not_covered: "未覆盖",
    unclear: "不明确",
    in_progress: "进行中"
  }
  return labels[value] || value || "未知"
}

function slugify(value) {
  const base = String(value || "requirement")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return base || "requirement"
}

function joinPath(dir, file) {
  return dir.replace(/\/+$/g, "") + "/" + file
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

function uniq(items) {
  // 原型无关字典:命令文本作 key,普通 {} 会让 "__proto__"/"toString" 这类
  // key 读到继承属性——uniq 里表现为静默丢弃合法条目(门禁变松方向)。
  const seen = Object.create(null)
  const out = []
  for (const item of items) {
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
  return items.slice(0, limit)
}

function lines(items) {
  if (!items || items.length === 0) return emptyText()
  return items.map((item) => `- ${item}`).join("\n")
}

function mergeExplorations(parts) {
  const relevantFiles = []
  const risks = []
  const suggestedTestCommands = []
  const summaries = []
  let confidence = "low"
  const rank = { low: 0, medium: 1, high: 2 }

  for (const part of parts) {
    if (!part) continue
    summaries.push(part.architectureSummary)
    for (const file of part.relevantFiles || []) relevantFiles.push(file)
    for (const risk of part.risks || []) risks.push(risk)
    for (const command of part.suggestedTestCommands || []) suggestedTestCommands.push(command)
    if (rank[part.confidence] > rank[confidence]) confidence = part.confidence
  }

  const seenFiles = Object.create(null)
  const uniqueFiles = []
  for (const file of relevantFiles) {
    if (!file || typeof file.path !== "string" || seenFiles[file.path]) continue
    seenFiles[file.path] = true
    uniqueFiles.push(file)
  }

  return {
    architectureSummary: summaries.filter(Boolean).join("\n\n") || "没有获得项目探索结果。",
    relevantFiles: uniqueFiles,
    risks: uniq(risks),
    suggestedTestCommands: uniq(suggestedTestCommands),
    confidence
  }
}

function fallbackImplementation(summary) {
  return {
    status: "blocked",
    summary,
    changedFiles: [],
    testsRun: [],
    blockers: [summary],
    followUps: []
  }
}

function fallbackVerification(summary) {
  return {
    status: "blocked",
    summary,
    commands: [],
    issues: [summary],
    recommendedFixes: []
  }
}

function fallbackReview(summary, criteria) {
  return {
    verdict: "blocked",
    summary,
    acceptanceCoverage: (criteria || []).map((criterion, index) => ({
      id: "AC-" + (index + 1),
      criterion,
      status: "unclear",
      evidence: "最终复核没有完成。"
    })),
    issues: [summary],
    nextActions: ["查看工作流运行历史，修复阻塞步骤后重新运行。"]
  }
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

function renderState(checkpoint, data) {
  return stringify({
    checkpoint,
    title: data.normalized ? data.normalized.title : null,
    status: data.status || checkpoint,
    artifacts: data.artifacts || {},
    summary: data.summary || "",
    blockers: data.blockers || [],
    stats: data.stats || {}
  })
}

function renderRequirementDoc(normalized, rawRequirement) {
  return `# 需求文档

## 标题

${normalized.title}

## 原始需求

${rawRequirement}

## 问题背景

${normalized.problem}

## 目标

${normalized.goal}

## 范围

${lines(normalized.scope)}

## 验收标准

${lines(normalized.acceptanceCriteria)}

## 约束

${lines(normalized.constraints)}

## 待确认项

${lines(normalized.unknowns)}

## 是否可以继续

${normalized.canProceed ? "可以继续" : "已阻塞"} — ${normalized.proceedReason}
`
}

function renderImpactDoc(exploration, stats) {
  return `# 影响分析

## 架构摘要

${exploration.architectureSummary}

## 相关文件

${
  (exploration.relevantFiles || [])
    .map((file) => `- ${file.path}：${file.reason}；预计变更：${file.expectedChange}`)
    .join("\n") || emptyText()
}

## 风险

${lines(exploration.risks)}

## 建议验证命令

${lines(exploration.suggestedTestCommands)}

## 探索统计

\`\`\`json
${stringify(stats)}
\`\`\`
`
}

function renderDesignDoc(normalized, exploration, plan) {
  return `# 技术设计

## 需求

${normalized.title}

## 实现思路

${plan.approach}

## 目标文件

${lines(plan.targetFiles)}

## 架构上下文

${exploration.architectureSummary}

## 风险与缓解措施

${lines(exploration.risks)}

## 回滚方案

${plan.rollbackPlan}
`
}

function renderPlanDoc(plan) {
  return `# 实现计划

## 步骤

${lines(plan.steps)}

## 目标文件

${lines(plan.targetFiles)}

## 测试命令

${lines(plan.testCommands)}

## 阻塞项

${lines(plan.blockers)}

## 是否需要人工决策

${plan.needsHumanDecision ? "是" : "否"}

## 回滚方案

${plan.rollbackPlan}
`
}

function renderImplementationDoc(implementation, fix) {
  return `# 实现报告

## 首轮实现

**状态：** ${statusText(implementation.status)}

${implementation.summary}

### 变更文件

${lines(implementation.changedFiles)}

### 实现阶段执行的测试

${lines(implementation.testsRun)}

### 阻塞项

${lines(implementation.blockers)}

### 后续事项

${lines(implementation.followUps)}

## 修复轮次

${
  fix
    ? `**状态：** ${statusText(fix.status)}

${fix.summary}

### 变更文件

${lines(fix.changedFiles)}

### 修复阶段执行的测试

${lines(fix.testsRun)}

### 阻塞项

${lines(fix.blockers)}

### 后续事项

${lines(fix.followUps)}
`
    : "不需要额外修复轮次。"
}
`
}

function renderVerifyDoc(verification, finalReview) {
  return `# 验证报告

## 验证结果

**状态：** ${statusText(verification.status)}

${verification.summary}

### 执行命令

${
  (verification.commands || [])
    .map((cmd) => `- \`${cmd.command}\`：${statusText(cmd.result)}。${cmd.evidence}`)
    .join("\n") || emptyText()
}

### 问题

${lines(verification.issues)}

### 建议修复

${lines(verification.recommendedFixes)}

## 最终验收复核

**结论：** ${statusText(finalReview.verdict)}

${finalReview.summary}

### 验收覆盖

${
  (finalReview.acceptanceCoverage || [])
    .map(
      (item) => `- ${statusText(item.status)}：[${item.id}] ${item.criterion} — ${item.evidence}`
    )
    .join("\n") || emptyText()
}

### 最终问题

${lines(finalReview.issues)}

### 下一步

${lines(finalReview.nextActions)}
`
}

function renderReport(data) {
  const normalized = data.normalized
  const exploration = data.exploration
  const plan = data.plan
  const implementation = data.implementation
  const verification = data.verification
  const fix = data.fix
  const finalReview = data.finalReview

  return `# 自动开发工作流交付报告

## 需求

**标题：** ${normalized.title}

**问题背景：** ${normalized.problem}

**目标：** ${normalized.goal}

### 验收标准

${lines(normalized.acceptanceCriteria)}

### 范围

${lines(normalized.scope)}

### 约束

${lines(normalized.constraints)}

### 待确认项

${lines(normalized.unknowns)}

## 项目探索

${exploration.architectureSummary}

### 相关文件

${
  (exploration.relevantFiles || [])
    .map((file) => `- ${file.path}：${file.reason}；预计变更：${file.expectedChange}`)
    .join("\n") || emptyText()
}

### 风险

${lines(exploration.risks)}

## 实现计划

${plan.approach}

### 步骤

${lines(plan.steps)}

### 目标文件

${lines(plan.targetFiles)}

### 测试命令

${lines(plan.testCommands)}

### 回滚方案

${plan.rollbackPlan}

## 实现

**状态：** ${statusText(implementation.status)}

${implementation.summary}

### 变更文件

${lines(implementation.changedFiles)}

### 实现阻塞项

${lines(implementation.blockers)}

## 验证

**状态：** ${statusText(verification.status)}

${verification.summary}

### 执行命令

${
  (verification.commands || [])
    .map((cmd) => `- \`${cmd.command}\`：${statusText(cmd.result)}。${cmd.evidence}`)
    .join("\n") || emptyText()
}

### 验证问题

${lines(verification.issues)}

### 建议修复

${lines(verification.recommendedFixes)}

## 修复轮次

${fix ? `**状态：** ${statusText(fix.status)}\n\n${fix.summary}\n\n变更文件：\n${lines(fix.changedFiles)}` : "不需要额外修复轮次。"}

## 最终复核

**结论：** ${statusText(finalReview.verdict)}

${finalReview.summary}

### 验收覆盖

${
  (finalReview.acceptanceCoverage || [])
    .map(
      (item) => `- ${statusText(item.status)}：[${item.id}] ${item.criterion} — ${item.evidence}`
    )
    .join("\n") || emptyText()
}

### 最终问题

${lines(finalReview.issues)}

### 下一步

${lines(finalReview.nextActions)}
`
}

const requirement = asRequirement(args)
const requestedOutputPath =
  args && typeof args === "object" && typeof args.outputPath === "string" ? args.outputPath : null
const requestedArtifactDir =
  args && typeof args === "object" && typeof args.artifactDir === "string" ? args.artifactDir : null
const fallbackArtifactDir = requestedArtifactDir || ".cmbdevclaw/自动开发工作流/最新"
let artifactDir = fallbackArtifactDir
let outputPath = requestedOutputPath || joinPath(fallbackArtifactDir, "交付报告.md")

if (!requirement) {
  throw new Error("缺少需求内容。请传入 args.requirement，或直接传入一段需求文本。")
}

phase("需求整理")
const normalized = await agent(
  `请把下面的开发需求整理成可执行的工程契约。

需求内容：
${requirement}

请判断是否可以在不继续询问用户的情况下安全进入实现阶段。
如果缺少重要信息，请将 canProceed 设为 false，并列出待确认项或阻塞点。
不要编造业务规则。`,
  {
    label: "需求整理",
    agentType: "Plan",
    schema: REQUIREMENT_SCHEMA
  }
)

if (!normalized || !normalized.canProceed) {
  if (normalized) {
    artifactDir = requestedArtifactDir || ".cmbdevclaw/自动开发工作流/" + slugify(normalized.title)
    outputPath = requestedOutputPath || joinPath(artifactDir, "交付报告.md")
  }
  const blockedReport = `# 自动开发工作流已阻塞

当前需求还不够明确，无法安全进入实现阶段。

## 需求

${requirement}

## 原因

${normalized ? normalized.proceedReason : "需求整理失败。"}

## 待确认项

${normalized ? lines(normalized.unknowns) : "- 需求整理失败"}
`
  await writeFile(
    joinPath(artifactDir, "状态.json"),
    renderState("requirement_blocked", {
      normalized,
      status: "blocked",
      summary: normalized ? normalized.proceedReason : "需求整理失败",
      blockers: normalized ? normalized.unknowns : ["需求整理失败"],
      artifacts: {
        deliveryReport: outputPath
      }
    })
  )
  await writeFile(outputPath, blockedReport)
  return {
    状态: "已阻塞",
    原因: normalized ? normalized.proceedReason : "需求整理失败",
    报告路径: outputPath
  }
}

log("需求：" + normalized.title)
artifactDir = requestedArtifactDir || ".cmbdevclaw/自动开发工作流/" + slugify(normalized.title)
outputPath = requestedOutputPath || joinPath(artifactDir, "交付报告.md")
const artifacts = {
  state: joinPath(artifactDir, "状态.json"),
  prd: joinPath(artifactDir, "需求文档.md"),
  impact: joinPath(artifactDir, "影响分析.md"),
  design: joinPath(artifactDir, "技术设计.md"),
  plan: joinPath(artifactDir, "实现计划.md"),
  implementation: joinPath(artifactDir, "实现报告.md"),
  verification: joinPath(artifactDir, "验证报告.md"),
  deliveryReport: outputPath
}
await writeFile(artifacts.prd, renderRequirementDoc(normalized, requirement))
await writeFile(
  artifacts.state,
  renderState("requirement_done", {
    normalized,
    status: "in_progress",
    summary: normalized.proceedReason,
    artifacts
  })
)

phase("项目探索")
const manifestPatterns = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "README.md",
  "AGENTS.md"
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
  "test/**/*.ts",
  "test/**/*.tsx",
  "tests/**/*.ts",
  "tests/**/*.tsx",
  "tests/**/*.java",
  "tests/**/*.py"
]

const manifests = uniq(
  (await parallel(manifestPatterns.map((pattern) => () => safeGlob(pattern)))).flat()
)
const sourceFiles = uniq(
  (await parallel(sourcePatterns.map((pattern) => () => safeGlob(pattern)))).flat()
)
throwIfGlobOverflow()
const manifestSnippets = []
for (const file of take(manifests, MAX_MANIFESTS)) {
  const content = await safeRead(file)
  if (content) {
    manifestSnippets.push(`--- ${file} ---\n${content.slice(0, 6000)}`)
  }
}

const fileInventory = take(sourceFiles, MAX_SOURCE_FILES)
log(
  "项目清单：" + manifests.length + " 个配置/说明文件，" + sourceFiles.length + " 个源码/测试文件"
)

const explorationParts = (
  await parallel(
    EXPLORE_LENSES.map(
      (lens) => () =>
        agent(
          `请围绕当前需求探索项目。你是只读探索代理，不能修改文件。

探索视角：${lens.label}
${lens.prompt}

需求契约：
${stringify(normalized)}

配置/说明文件片段：
${manifestSnippets.join("\n\n") || "未找到"}

候选源码/测试文件列表（已截断）：
${lines(fileInventory)}

请从这个视角返回具体文件路径、风险和可用的测试命令。不要修改文件。`,
          {
            label: "探索：" + lens.label,
            phase: "项目探索",
            agentType: "Explore",
            schema: EXPLORE_SCHEMA
          }
        )
    )
  )
).filter(Boolean)

const exploration = mergeExplorations(explorationParts)
const explorationStats = {
  manifests: manifests.length,
  sourceFiles: sourceFiles.length,
  explorationLenses: explorationParts.length,
  relevantFiles: exploration.relevantFiles.length
}
log(
  "探索结果：" +
    explorationParts.length +
    "/" +
    EXPLORE_LENSES.length +
    " 个视角返回，" +
    exploration.relevantFiles.length +
    " 个相关文件"
)
await writeFile(artifacts.impact, renderImpactDoc(exploration, explorationStats))
await writeFile(
  artifacts.state,
  renderState("explore_done", {
    normalized,
    status: "in_progress",
    summary: "项目探索已完成。",
    artifacts,
    stats: explorationStats
  })
)

phase("实现计划")
const plan = await agent(
  `请为当前需求制定实现计划。

需求契约：
${stringify(normalized)}

项目探索结果：
${stringify(exploration)}

请返回简洁但可执行的计划。
如果需求存在安全风险或信息不足，请将 needsHumanDecision 设为 true 并列出阻塞项。
否则将 needsHumanDecision 设为 false。`,
  {
    label: "实现计划",
    phase: "实现计划",
    agentType: "Plan",
    schema: PLAN_SCHEMA
  }
)

if (!plan || plan.needsHumanDecision) {
  if (plan) {
    await writeFile(artifacts.design, renderDesignDoc(normalized, exploration, plan))
    await writeFile(artifacts.plan, renderPlanDoc(plan))
  }
  const blockedReport = `# 自动开发工作流在实现前阻塞

## 需求

${stringify(normalized)}

## 项目探索

${stringify(exploration)}

## 计划

${stringify(plan)}
`
  await writeFile(
    artifacts.state,
    renderState("plan_blocked", {
      normalized,
      status: "blocked",
      summary: plan ? "计划阶段需要人工决策。" : "计划生成失败。",
      blockers: plan ? plan.blockers : ["计划生成失败"],
      artifacts,
      stats: explorationStats
    })
  )
  await writeFile(outputPath, blockedReport)
  return {
    状态: "已阻塞",
    原因: plan ? lines(plan.blockers) : "计划生成失败",
    报告路径: outputPath
  }
}
await writeFile(artifacts.design, renderDesignDoc(normalized, exploration, plan))
await writeFile(artifacts.plan, renderPlanDoc(plan))
await writeFile(
  artifacts.state,
  renderState("plan_done", {
    normalized,
    status: "in_progress",
    summary: "实现计划已完成。",
    artifacts,
    stats: explorationStats
  })
)

phase("代码实现")
const implementation =
  (await agent(
    `请在当前工作区实现这个需求。

需求契约：
${stringify(normalized)}

项目探索结果：
${stringify(exploration)}

实现计划：
${stringify(plan)}

执行要求：
- 做最小且正确的代码修改。
- 不要做无关重构。
- 保持现有代码风格和架构。
- 如果计划要求补测试，请新增或更新测试。
- 如果无法安全实现，不要假装成功；请返回 status=blocked，并说明具体阻塞项。
- 完成后调用 structured_output，返回变更文件、执行过的命令、阻塞项和后续事项。`,
    {
      label: "代码实现",
      phase: "代码实现",
      schema: IMPLEMENTATION_SCHEMA
    }
  )) || fallbackImplementation("实现代理没有返回结构化结果。")

phase("验证")
const verification =
  implementation.status === "blocked"
    ? fallbackVerification("实现阶段已阻塞，因此未运行验证。")
    : (await agent(
        `请根据需求验证本次实现。

需求契约：
${stringify(normalized)}

实现计划：
${stringify(plan)}

实现结果：
${stringify(implementation)}

如果可以，请使用 shell 运行聚焦的验证命令。
计划中的命令必须按声明的原样逐条执行(不得加参数/前缀/环境变量改变其语义——门禁按上报的 command 字段裁决,窄化执行等同虚报),并按原字符串填入 commands.command 报告结果;确需补充的命令另行执行、作为额外条目如实报告。
不要修改文件。
请返回通过/失败/阻塞结论，并给出证据。`,
        {
          label: "验证实现",
          phase: "验证",
          agentType: "verification",
          schema: VERIFY_SCHEMA
        }
      )) || fallbackVerification("验证代理没有返回结构化结果。")

let fix = null
let verificationAfterFix = verification
if (
  verification &&
  (verification.status === "fail" || verification.status === "blocked") &&
  implementation &&
  implementation.status !== "blocked"
) {
  phase("代码实现")
  fix =
    (await agent(
      `验证阶段发现了问题。请执行一次聚焦修复。

需求契约：
${stringify(normalized)}

原始计划：
${stringify(plan)}

实现结果：
${stringify(implementation)}

验证结果：
${stringify(verification)}

执行要求：
- 只修复验证阶段指出的问题。
- 不要扩大范围。
- 如果无法安全修复，请返回 status=blocked 并说明原因。`,
      {
        label: "修复验证问题",
        phase: "代码实现",
        schema: IMPLEMENTATION_SCHEMA
      }
    )) || fallbackImplementation("修复代理没有返回结构化结果。")

  phase("验证")
  verificationAfterFix =
    fix.status === "blocked"
      ? fallbackVerification("修复阶段已阻塞，因此未重新验证。")
      : (await agent(
          `请在修复后重新运行聚焦验证。

需求契约：
${stringify(normalized)}

实现计划：
${stringify(plan)}

初始实现：
${stringify(implementation)}

修复结果：
${stringify(fix)}

上一次验证：
${stringify(verification)}

计划中的命令必须按声明的原样逐条执行(不得加参数/前缀窄化范围),按原字符串填入 commands.command 报告结果;此外聚焦复查之前失败的问题。不要修改文件。`,
          {
            label: "修复后验证",
            phase: "验证",
            agentType: "verification",
            schema: VERIFY_SCHEMA
          }
        )) || fallbackVerification("修复后验证代理没有返回结构化结果。")
}

phase("最终复核")
const finalReview =
  (await agent(
    `请复核最终工作区状态是否满足原始需求。

需求契约：
${stringify(normalized)}

实现计划：
${stringify(plan)}

实现结果：
${stringify(implementation)}

修复结果：
${stringify(fix)}

验证结果：
${stringify(verificationAfterFix)}

验收标准清单（acceptanceCoverage 必须按下面的 id 逐条返回,不得遗漏、不得使用清单外的 id）：
${(normalized.acceptanceCriteria || [])
  .map((text, index) => `- AC-${index + 1}: ${text}`)
  .join("\n")}

请逐条检查验收标准。不要修改文件。返回最终结论。`,
    {
      label: "最终验收复核",
      phase: "最终复核",
      agentType: "verification",
      schema: REVIEW_SCHEMA
    }
  )) || fallbackReview("最终复核代理没有返回结构化结果。", normalized.acceptanceCriteria)

// 硬门禁:"可交付"由代码合裁,不单信复核代理——必须同时满足:复核 ready、
// 验证状态 pass 且无失败命令、验收覆盖按稳定 ID 对齐原始验收标准(AC-1..AC-N
// 每条都有 covered 且证据非空的条目;无关条目凑数、措辞改写都无法绕过 ID 集合)。
// 任一不满足即降级为 needs_fix。
// 必须在任何报告落盘之前执行,保证验证报告/交付报告/状态三者口径一致。
if (finalReview.verdict === "ready") {
  const failedCommands = (verificationAfterFix.commands || []).filter(
    (item) => item.result === "fail"
  )
  // 计划声明的测试命令必须逐条被报告且通过:缺失/not_run/fail 都不放行。
  // 重复上报聚合取"最坏":先 fail 后 pass 不得被覆盖。
  const reportedCmd = Object.create(null)
  for (const item of verificationAfterFix.commands || []) {
    const key = normalizeCommandText(item.command)
    const existing = reportedCmd[key]
    if (!existing || existing.result === "pass") reportedCmd[key] = item
  }
  const unexecutedDeclared = uniq(plan.testCommands || []).filter((cmd) => {
    const entry = reportedCmd[normalizeCommandText(cmd)]
    return !entry || entry.result !== "pass"
  })
  const verificationOk =
    verificationAfterFix.status === "pass" &&
    failedCommands.length === 0 &&
    unexecutedDeclared.length === 0
  const coverage = finalReview.acceptanceCoverage || []
  const expectedCriteria = normalized.acceptanceCriteria || []
  const expectedIds = expectedCriteria.map((_, index) => "AC-" + (index + 1))
  const coveredIds = new Set(
    coverage
      .filter((item) => item.status === "covered" && String(item.evidence || "").trim().length > 0)
      .map((item) =>
        String(item.id || "")
          .trim()
          .toUpperCase()
      )
  )
  const missingIds = expectedIds.filter((id) => !coveredIds.has(id))
  const coverageOk = expectedIds.length > 0 && missingIds.length === 0
  if (!verificationOk || !coverageOk) {
    const reason = [
      !verificationOk
        ? `验证未真正通过(状态“${statusText(verificationAfterFix.status)}”${
            failedCommands.length > 0
              ? `,失败命令:${failedCommands.map((item) => item.command).join("、")}`
              : ""
          }${
            unexecutedDeclared.length > 0
              ? `,计划命令未执行或未通过:${unexecutedDeclared.join("、")}`
              : ""
          })`
        : "",
      !coverageOk
        ? `验收覆盖未对齐原始标准(未覆盖:${missingIds.join("、") || "无有效标准"};每条必须按 id 返回 covered 且证据非空)`
        : ""
    ]
      .filter(Boolean)
      .join("；")
    log(`最终复核结论 ready 被硬门禁降级为 needs_fix：${reason}`)
    finalReview.verdict = "needs_fix"
    finalReview.summary = `【硬门禁降级】${reason}。原复核结论（仅供参考）：${finalReview.summary}`
    finalReview.issues = uniq([...(finalReview.issues || []), `硬门禁降级：${reason}`])
    finalReview.nextActions = uniq([
      ...(finalReview.nextActions || []),
      "修复验证/覆盖问题后重新运行工作流。"
    ])
  }
}

phase("写入报告")
await writeFile(artifacts.implementation, renderImplementationDoc(implementation, fix))
await writeFile(artifacts.verification, renderVerifyDoc(verificationAfterFix, finalReview))
const report = renderReport({
  normalized,
  exploration,
  plan,
  implementation,
  verification: verificationAfterFix,
  fix,
  finalReview
})
await writeFile(outputPath, report)
const finalStatus = finalReview.verdict === "ready" ? "ready" : finalReview.verdict
const changedFiles = take(
  uniq([...(implementation.changedFiles || []), ...((fix && fix.changedFiles) || [])]),
  MAX_CHANGED_FILES
)
const stats = {
  manifests: manifests.length,
  sourceFiles: sourceFiles.length,
  explorationLenses: explorationParts.length,
  relevantFiles: exploration.relevantFiles.length,
  agentCalls:
    1 +
    EXPLORE_LENSES.length +
    1 +
    1 +
    (implementation.status === "blocked" ? 0 : 1) +
    (fix ? 2 : 0) +
    1
}
await writeFile(
  artifacts.state,
  // blocked 独立落账(镜像 plan_blocked/requirement_blocked 先例)。
  renderState(
    finalStatus === "ready"
      ? "verify_done"
      : finalStatus === "blocked"
        ? "verify_blocked"
        : "needs_fix",
    {
      normalized,
      status: finalStatus,
      summary: finalReview.summary,
      blockers: finalReview.issues,
      artifacts,
      stats
    }
  )
)

const visibleArtifacts = {
  状态文件: artifacts.state,
  需求文档: artifacts.prd,
  影响分析: artifacts.impact,
  技术设计: artifacts.design,
  实现计划: artifacts.plan,
  实现报告: artifacts.implementation,
  验证报告: artifacts.verification,
  交付报告: artifacts.deliveryReport
}

return {
  状态: statusText(finalStatus),
  报告路径: outputPath,
  产物目录: artifactDir,
  产物: visibleArtifacts,
  标题: normalized.title,
  变更文件: changedFiles,
  验证状态: statusText(verificationAfterFix.status),
  最终问题: finalReview.issues,
  下一步: finalReview.nextActions,
  统计: {
    配置文件数: stats.manifests,
    源码测试文件数: stats.sourceFiles,
    探索视角数: stats.explorationLenses,
    相关文件数: stats.relevantFiles,
    代理调用数: stats.agentCalls
  }
}
