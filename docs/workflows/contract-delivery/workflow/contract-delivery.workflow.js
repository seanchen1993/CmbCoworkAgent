export const meta = {
  name: "契约驱动端到端交付",
  description:
    "把需求固化为逐条可核查的验收合同，多轮自主实现-验证-对抗复核，直到每条标准都有证据；交付逐条对照的证据矩阵。",
  whenToUse:
    "端到端交付开发需求时使用，简单/中等/复杂需求同一入口：成契时自动评定复杂度档位，simple 档跳过规划代理与多视角探索（低开销直通），standard/complex 档走完整多轮收敛。需求先成契（每条验收标准带 ID 和核查方式），执行按轮次收敛（每轮只做未证实的标准），同一需求文本重跑即续跑。可选 args：contract（预先协商好的合同对象）、complexity（simple|standard|complex 覆盖自动档位）、artifactDir、outputPath、resume:false、forceAcIds、maxRounds、maxFixRounds。",
  phases: [
    { title: "成契" },
    { title: "项目探索" },
    { title: "交付循环" },
    { title: "终审" },
    { title: "交付报告" }
  ]
}

const WORKFLOW_VERSION = 1
const DEFAULT_ARTIFACT_ROOT = ".cmbdevclaw/契约交付"
const MAX_MANIFESTS = 16
const MAX_SOURCE_FILES = 500
const MAX_ROUNDS = 3
const MAX_PACKAGES_PER_ROUND = 8
const MAX_FIX_ROUNDS = 2
const MAX_CHANGED_FILES = 120

// ---------- 结构化输出 schema ----------

const CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    problem: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    complexity: { type: "string", enum: ["simple", "standard", "complex"] },
    nonGoals: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    conventions: { type: "array", items: { type: "string" } },
    criteria: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1 },
          verify: { type: "string", enum: ["command", "code", "test", "e2e"] },
          hint: { type: "string" }
        },
        required: ["id", "text", "verify", "hint"],
        additionalProperties: false
      }
    },
    globalValidationCommands: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    canProceed: { type: "boolean" },
    proceedReason: { type: "string" }
  },
  required: [
    "title",
    "problem",
    "goal",
    "complexity",
    "nonGoals",
    "constraints",
    "conventions",
    "criteria",
    "globalValidationCommands",
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

const ROUND_PLAN_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string" },
    conventionsBrief: { type: "string", minLength: 1 },
    packages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          acIds: { type: "array", items: { type: "string" }, minItems: 1 },
          targetFiles: { type: "array", items: { type: "string" } },
          validationCommands: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: [
          "id",
          "title",
          "objective",
          "acIds",
          "targetFiles",
          "validationCommands",
          "dependencies",
          "riskLevel"
        ],
        additionalProperties: false
      }
    },
    canImplement: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } }
  },
  required: ["strategy", "conventionsBrief", "packages", "canImplement", "blockers"],
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

const PACKAGE_VERIFY_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "fail", "blocked"] },
    summary: { type: "string" },
    perAc: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "unclear"] },
          evidence: { type: "string" }
        },
        required: ["id", "result", "evidence"],
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
    issues: { type: "array", items: { type: "string" } },
    recommendedFixes: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary", "perAc", "commandChecks", "issues", "recommendedFixes"],
  additionalProperties: false
}

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    refutations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string", minLength: 1 }
        },
        required: ["id", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "refutations"],
  additionalProperties: false
}

const RUNNER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          passed: { type: "boolean" },
          evidence: { type: "string" }
        },
        required: ["command", "passed", "evidence"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "commands"],
  additionalProperties: false
}

// ---------- 通用工具 ----------

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

// 外部注入的合同字段可能是半结构化输入(单个字符串而非数组)——宽容归一化,
// 而不是让 lines()/渲染在运行中途抛异常。
function asStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
  }
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()]
  return []
}

function joinPath(dir, file) {
  return dir.replace(/\/+$/g, "") + "/" + file.replace(/^\/+/g, "")
}

function slugify(value) {
  const base = String(value || "requirement")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return base || "requirement"
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  // 预算类参数必须取整:1.5 轮/1.5 个任务会让 < 比较多跑一轮/一个。
  return Math.floor(Math.max(min, Math.min(parsed, max)))
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
    unproven: "未证实",
    proven: "已证实",
    refuted: "被驳回",
    pass: "通过",
    fail: "失败",
    unclear: "不明确",
    not_run: "未运行",
    changed: "已修改",
    no_change_needed: "无需修改",
    blocked: "已阻塞",
    ready: "可交付",
    needs_fix: "需要修复"
  }
  return labels[value] || value || "未知"
}

// 引擎沙箱暴露的 budget 全局（输出 token 计量）；不存在时安静降级为 null。
function tokensSpent() {
  return typeof budget !== "undefined" && budget && typeof budget.spent === "function"
    ? budget.spent()
    : null
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

// ---------- 合同与账本 ----------

// 验收标准账本（ledger）是本范式的核心状态：每条标准从 unproven 走向 proven，
// 证据、轮次、驳回原因都记录在案。交付的定义 = 账本上每条标准都有证据。
function normalizeCriteria(rawCriteria) {
  const seen = Object.create(null)
  const out = []
  for (let i = 0; i < rawCriteria.length; i++) {
    const raw = rawCriteria[i] || {}
    const text = String(raw.text || "").trim()
    if (!text) continue // 空文本的标准没有可证实的内容,直接剔除
    let id = typeof raw.id === "string" ? raw.id.trim().toUpperCase() : ""
    if (!/^AC-\d+$/.test(id) || seen[id]) {
      let n = i + 1
      while (seen["AC-" + n]) n += 1
      id = "AC-" + n
    }
    seen[id] = true
    out.push({
      id,
      text,
      verify: ["command", "test", "e2e"].includes(raw.verify) ? raw.verify : "code",
      // hint 与 text 同样 trim:它进合同指纹,尾随空白差异不该被当成新合同
      // (那会重建账本、把已证实的标准全部重跑一遍)。
      hint: String(raw.hint || "").trim(),
      status: "unproven",
      evidence: "",
      note: "",
      round: 0
    })
  }
  return out
}

function criterionById(criteria, id) {
  for (const c of criteria) if (c.id === id) return c
  return null
}

function unresolvedCriteria(criteria) {
  return criteria.filter((c) => c.status !== "proven")
}

function normalizePackages(rawPackages, criteria) {
  const seen = Object.create(null)
  const idMap = Object.create(null)
  const droppedAcRefs = []
  const droppedDeps = []
  const packages = []
  for (let i = 0; i < rawPackages.length; i++) {
    const raw = rawPackages[i]
    let id = slugify(raw.id || raw.title || `pkg-${i + 1}`).slice(0, 48) || `pkg-${i + 1}`
    let suffix = 2
    while (seen[id]) {
      id = id + "-" + suffix
      suffix += 1
    }
    seen[id] = true
    // 维护 raw id / 标题 → 规范 id 的映射(与 assignStableTaskIds 同构):
    // 规划代理用原始 id 或标题引用依赖时不会静默断链。
    if (typeof raw.id === "string" && raw.id && !idMap[raw.id]) idMap[raw.id] = id
    if (typeof raw.title === "string" && raw.title && !idMap[raw.title]) idMap[raw.title] = id
    idMap[id] = id
    const acIds = []
    for (const ref of raw.acIds || []) {
      const normalized = String(ref || "")
        .trim()
        .toUpperCase()
      if (criterionById(criteria, normalized)) {
        if (!acIds.includes(normalized)) acIds.push(normalized)
      } else {
        droppedAcRefs.push(`${id} -> ${ref}`)
      }
    }
    packages.push({ ...raw, id, acIds })
  }
  const remapped = packages.map((pkg) => {
    const dependencies = []
    for (const dep of pkg.dependencies || []) {
      const key = String(dep || "")
      const target = idMap[key] || idMap[slugify(key).slice(0, 48)] || null
      if (target && target !== pkg.id) {
        if (!dependencies.includes(target)) dependencies.push(target)
      } else if (!target) {
        droppedDeps.push(`${pkg.id} -> ${dep}`)
      }
    }
    return { ...pkg, dependencies }
  })
  return { packages: remapped, droppedAcRefs, droppedDeps }
}

function topoSortPackages(packages) {
  const byId = Object.create(null)
  for (const pkg of packages) byId[pkg.id] = pkg
  const visited = Object.create(null)
  const visiting = Object.create(null)
  const ordered = []
  let cyclic = false
  function visit(pkg) {
    if (visited[pkg.id]) return
    if (visiting[pkg.id]) {
      cyclic = true
      return
    }
    visiting[pkg.id] = true
    for (const dep of pkg.dependencies || []) {
      if (byId[dep]) visit(byId[dep])
    }
    visiting[pkg.id] = false
    visited[pkg.id] = true
    ordered.push(pkg)
  }
  for (const pkg of packages) visit(pkg)
  return { packages: ordered, cyclic }
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

function fallbackVerification(summary, acIds) {
  return {
    status: "blocked",
    summary,
    perAc: (acIds || []).map((id) => ({ id, result: "fail", evidence: summary })),
    commandChecks: [],
    issues: [summary],
    recommendedFixes: []
  }
}

// 验证结论的完整性由代码强制：包内每条 AC 必须有裁决；漏核 = fail，pass 无证据 = fail。
// 内容真假模型说了算，但"每条都核过、每条 pass 都有证据"在结构上不可跳过。
// 另有总分一致性:命令检查存在失败、或总体状态非 pass 而明细全 pass 时,属于
// 矛盾输出——所有 pass 明细一并降级,防止"包级失败但 AC 仍被证实"的假阳性。
function enforcePerAcCompleteness(verification, pkg) {
  const effective = []
  for (const acId of pkg.acIds) {
    const entry = (verification.perAc || []).find(
      (p) =>
        String(p.id || "")
          .trim()
          .toUpperCase() === acId
    )
    if (!entry) {
      effective.push({ id: acId, result: "fail", evidence: "验证代理未核查该标准。" })
    } else if (entry.result === "pass" && !String(entry.evidence || "").trim()) {
      effective.push({ id: acId, result: "fail", evidence: "结论为通过但未提供证据。" })
    } else {
      effective.push({ id: acId, result: entry.result, evidence: entry.evidence })
    }
  }
  const known = Object.create(null)
  for (const item of effective) known[item.id] = true
  for (const extra of verification.perAc || []) {
    const id = String(extra.id || "")
      .trim()
      .toUpperCase()
    if (!known[id]) log(`验证结论包含不属于本工作包的标准，已忽略：${id}`)
  }

  const failedCommands = (verification.commandChecks || []).filter((item) => item.result === "fail")
  // 同一声明命令被重复上报时聚合取"最坏"结果:先 fail 后 pass 不得被 pass
  // 覆盖——任何一次失败都足以否定该命令的证据基础。
  const reportedCmd = Object.create(null)
  for (const item of verification.commandChecks || []) {
    const key = normalizeCommandText(item.command)
    const existing = reportedCmd[key]
    if (!existing || existing.result === "pass") reportedCmd[key] = item
  }
  const unexecutedDeclared = uniq(pkg.validationCommands || []).filter((cmd) => {
    const entry = reportedCmd[normalizeCommandText(cmd)]
    return !entry || entry.result !== "pass"
  })
  const allRowsPass = effective.length > 0 && effective.every((item) => item.result === "pass")
  const contradictions = []
  if (failedCommands.length > 0) {
    contradictions.push("存在失败命令:" + failedCommands.map((item) => item.command).join("、"))
  }
  if (unexecutedDeclared.length > 0) {
    // 工作包声明的验证命令缺失/not_run/失败都视为证据基础不完整,通过结论不予采信。
    contradictions.push("声明的验证命令未执行或未通过:" + unexecutedDeclared.join("、"))
  }
  if (allRowsPass && verification.status !== "pass") {
    contradictions.push(`总体状态为 ${statusText(verification.status)} 与明细全通过矛盾`)
  }
  if (contradictions.length > 0) {
    const note = "包级验证不一致(" + contradictions.join(";") + "),通过结论不予采信。"
    for (const item of effective) {
      if (item.result === "pass") {
        item.result = "fail"
        item.evidence = note + " 原证据:" + item.evidence
      }
    }
  }
  return { ...verification, perAc: effective }
}

// ---------- 状态与文档 ----------

function renderState(data) {
  return stringify({
    version: WORKFLOW_VERSION,
    mode: "contract-delivery",
    checkpoint: data.checkpoint,
    requirement: data.requirement,
    artifactDir: data.artifactDir,
    outputPath: data.outputPath,
    contract: data.contract || null,
    contractFingerprint: data.contractFingerprint || "",
    exploration: data.exploration || null,
    explorationComplexity: data.explorationComplexity || "",
    conventionsBrief: data.conventionsBrief || "",
    criteria: data.criteria || [],
    roundsUsed: data.roundsUsed || 0,
    changedFiles: data.changedFiles || [],
    summary: data.summary || "",
    blockers: data.blockers || []
  })
}

async function writeState(context, checkpoint, summary, blockers) {
  await writeFile(
    context.artifacts.state,
    renderState({
      checkpoint,
      requirement: context.requirement,
      artifactDir: context.artifactDir,
      outputPath: context.outputPath,
      contract: context.contract,
      contractFingerprint: context.contractFingerprint,
      exploration: context.exploration,
      explorationComplexity: context.explorationComplexity,
      conventionsBrief: context.conventionsBrief,
      criteria: context.criteria,
      roundsUsed: context.roundsUsed,
      changedFiles: context.changedFiles,
      summary,
      blockers: blockers || []
    })
  )
}

function renderContractDoc(contract, criteria, requirement) {
  return `# 交付合同

## 标题

${contract.title}

## 原始需求

${requirement}

## 问题背景

${contract.problem}

## 目标

${contract.goal}

## 非目标

${lines(contract.nonGoals)}

## 约束

${lines(contract.constraints)}

## 公约（跨任务约定）

${lines(contract.conventions)}

## 全局验证命令

${lines(contract.globalValidationCommands)}

## 验收标准清单

${criteria
  .map(
    (c) => `- **${c.id}**（核查方式：${c.verify}）：${c.text}${c.hint ? `（提示：${c.hint}）` : ""}`
  )
  .join("\n")}
`
}

function renderProjectProfile(exploration) {
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
`
}

function renderRoundPlanDoc(round, plan, coverage) {
  return `# 第 ${round} 轮规划

## 策略

${plan.strategy}

## 公约简报

${plan.conventionsBrief}

## 覆盖情况

- 本轮待证实标准：${coverage.target.join("、") || "无"}
- 已认领：${coverage.claimed.join("、") || "无"}
- 未认领（保持未证实并告警）：${coverage.unclaimed.join("、") || "无"}

## 工作包

${plan.packages
  .map(
    (pkg, index) => `### ${index + 1}. ${pkg.title}

- ID：\`${pkg.id}\`
- 目标：${pkg.objective}
- 覆盖标准：${pkg.acIds.join("、")}
- 依赖：${pkg.dependencies.length ? pkg.dependencies.join("、") : "无"}
- 风险：${pkg.riskLevel}
- 目标文件：${pkg.targetFiles.length ? pkg.targetFiles.join(", ") : "实现时确认"}
- 验证命令：${pkg.validationCommands.length ? pkg.validationCommands.join("; ") : "无"}
`
  )
  .join("\n")}
`
}

function renderPackageDoc(pkg, implementation, fix, verification) {
  return `# 工作包报告：${pkg.title}

## 实现

**状态：** ${statusText(implementation.status)}

${implementation.summary}

变更文件：
${lines(implementation.changedFiles)}

执行命令：
${lines(implementation.commandsRun)}

阻塞项：
${lines(implementation.blockers)}

## 修复轮次

${fix ? `**状态：** ${statusText(fix.status)}\n\n${fix.summary}\n\n变更文件：\n${lines(fix.changedFiles)}` : "未执行修复轮次。"}

## 逐条验证

**总体：** ${statusText(verification.status)} — ${verification.summary}

${verification.perAc.map((p) => `- ${p.id}：${statusText(p.result)} — ${p.evidence}`).join("\n")}

命令检查：
${
  (verification.commandChecks || [])
    .map((c) => `- \`${c.command}\`：${statusText(c.result)}。${c.evidence}`)
    .join("\n") || "- 无"
}

问题：
${lines(verification.issues)}
`
}

function renderDeliveryReport(context, verdict, runnerResult, verdictReason) {
  const criteria = context.criteria
  const proven = criteria.filter((c) => c.status === "proven")
  return `# 契约交付报告

## 总体结论

**状态：** ${statusText(verdict)}

${verdictReason}

## 需求

${context.contract.title}

## 验收矩阵（${proven.length}/${criteria.length} 已证实）

| ID | 验收标准 | 状态 | 轮次 | 证据 / 备注 |
|---|---|---|---|---|
${criteria
  .map(
    (c) =>
      `| ${c.id} | ${c.text.replace(/\|/g, "，")} | ${statusText(c.status)} | ${c.round || "-"} | ${(c.status === "proven" ? c.evidence : c.note || c.evidence || "无").replace(/\|/g, "，").replace(/\n/g, " ")} |`
  )
  .join("\n")}

## 终审命令核对

${
  runnerResult
    ? runnerResult.commands
        .map((c) => `- \`${c.command}\`：${c.passed ? "通过" : "失败"} — ${c.evidence}`)
        .join("\n")
    : "- 未执行（合同未定义全局验证命令）"
}

## 变更文件

${lines(take(context.changedFiles, MAX_CHANGED_FILES))}

## 执行统计

- 轮次：${context.roundsUsed}
- 已证实 / 总标准：${proven.length} / ${criteria.length}
- 输出 token：${context.tokensOut != null ? context.tokensOut : "未知"}

## 下一步

${
  verdict === "ready"
    ? "- 全部验收标准已证实，可进入提交/PR 流程。"
    : unresolvedCriteria(criteria)
        .map((c) => `- ${c.id}（${statusText(c.status)}）：${c.note || c.text}`)
        .join("\n") || "- 检查终审命令失败项后重跑同一需求即可续跑。"
}

## 关键产物

- 状态文件（账本）：${context.artifacts.state}
- 交付合同：${context.artifacts.contract}
- 项目画像：${context.artifacts.profile}
- 交付报告：${context.artifacts.report}
`
}

// ---------- 主流程 ----------

const options = argObject()
const requirement = asRequirement(args)
const resumeEnabled = options.resume !== false
const maxRounds = numberInRange(options.maxRounds, MAX_ROUNDS, 1, 6)
const maxFixRounds = numberInRange(options.maxFixRounds, MAX_FIX_ROUNDS, 0, MAX_FIX_ROUNDS)
const forceAcIds = Array.isArray(options.forceAcIds)
  ? options.forceAcIds.map((id) => String(id).trim().toUpperCase())
  : []

if (!requirement) {
  throw new Error("缺少需求内容。请传入 args.requirement，或直接传入一段需求文本。")
}

// 产物目录锚定在原始需求文本上：同一需求重跑时路径稳定，账本才能被找到并续跑。
const artifactDir =
  typeof options.artifactDir === "string"
    ? options.artifactDir
    : joinPath(DEFAULT_ARTIFACT_ROOT, slugify(requirement))
const outputPath =
  typeof options.outputPath === "string" ? options.outputPath : joinPath(artifactDir, "交付报告.md")
const artifacts = {
  state: joinPath(artifactDir, "状态.json"),
  contract: joinPath(artifactDir, "交付合同.md"),
  profile: joinPath(artifactDir, "项目画像.md"),
  report: outputPath
}
const previousState = resumeEnabled ? await readJson(artifacts.state) : null
const canReuse =
  !!previousState &&
  previousState.version === WORKFLOW_VERSION &&
  previousState.mode === "contract-delivery" &&
  previousState.requirement === requirement
const hasExplicitContract =
  options.contract &&
  typeof options.contract === "object" &&
  Array.isArray(options.contract.criteria)
if (options.contract && !hasExplicitContract) {
  // contract 是公开参数:传了但形状不合法(criteria 缺失/拼错/非数组)时,
  // 静默当没传会让续跑复用旧合同——必须显式报错。
  throw new Error("options.contract 形状不合法:必须是携带 criteria 数组的对象(请检查字段拼写)。")
}

// 显式合同的稳定指纹:只捕捉"验收语义"(标准/命令/约束/公约/非目标)。
// 元数据(title/problem/goal/complexity)有意不入指纹——它们是执行策略与呈现,
// 变更时应"续跑进度 + 生效新元数据",而不是重置账本。
// 指纹一致 → 同一合同,按账本续跑未完成标准;不一致 → 新合同,全部重建。
function contractFingerprintOf(criteriaList, contractLike) {
  // criteria 按 id 排序(id↔text 映射不变即同一语义;注意不能对"输入"重排——
  // 自动分配的 id 依赖位置);公约/约束/命令/非目标语义无序,排序 + trim 后
  // 入指纹,避免顺序调整或尾随空白造成不必要的账本重置。
  const sortedCriteria = criteriaList
    .map(({ id, text, verify, hint }) => ({ id, text, verify, hint }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const sortedArr = (value) => [...asStringArray(value)].sort()
  // 命令入指纹前经 normalizeCommandText:门禁匹配已按归一化口径,指纹若对
  // 内部空白敏感,`mvn  test` 与 `mvn test` 会被当成新合同、误重置账本——
  // 与技能文档"顺序与空白不敏感"的承诺不一致。
  const sortedCmds = (value) => [...asStringArray(value)].map(normalizeCommandText).sort()
  return stringify({
    criteria: sortedCriteria,
    globalValidationCommands: sortedCmds(contractLike.globalValidationCommands),
    constraints: sortedArr(contractLike.constraints),
    conventions: sortedArr(contractLike.conventions),
    nonGoals: sortedArr(contractLike.nonGoals)
  })
}
let explicitCriteria = null
let explicitFingerprint = null
if (hasExplicitContract) {
  explicitCriteria = normalizeCriteria(options.contract.criteria)
  if (explicitCriteria.length === 0) {
    // 零条有效标准的合同会让 every() 空真、直接"可交付"——必须硬性拒绝。
    throw new Error("外部合同必须包含至少一条有效验收标准（text 非空）。")
  }
  explicitFingerprint = contractFingerprintOf(explicitCriteria, options.contract)
}
// 旧状态可能没有 contractFingerprint(升级前写入):用状态里的合同现场回算,
// 避免同一合同在升级后被误判为"新合同"而白白重置一次账本。
const stateFingerprint = canReuse
  ? (Array.isArray(previousState.criteria) &&
    previousState.criteria.length > 0 &&
    previousState.contract
      ? contractFingerprintOf(previousState.criteria, previousState.contract)
      : null) ||
    previousState.contractFingerprint ||
    null
  : null
const explicitContractMatchesState =
  hasExplicitContract &&
  canReuse &&
  stateFingerprint === explicitFingerprint &&
  Array.isArray(previousState.criteria) &&
  previousState.criteria.length > 0
// 旧进度(账本/轮次/变更清单/画像)是否可复用:同需求续跑,且要么没有显式合同,
// 要么显式合同与状态指纹一致。
const reusePriorProgress = canReuse && (!hasExplicitContract || explicitContractMatchesState)

const context = {
  requirement,
  artifactDir,
  outputPath,
  artifacts,
  contract: null,
  contractFingerprint: "",
  explorationComplexity: "",
  exploration: null,
  conventionsBrief: "",
  criteria: [],
  // 轮次跨续跑连续计数:续跑的新轮次接着编号(round N+1...),既保留历史轮次
  // 产物目录不被覆盖,报告里的轮次也反映真实累计;每次调用仍有完整的 maxRounds 预算。
  roundsUsed:
    reusePriorProgress && Number.isFinite(previousState.roundsUsed) ? previousState.roundsUsed : 0,
  changedFiles:
    reusePriorProgress && Array.isArray(previousState.changedFiles)
      ? previousState.changedFiles
      : []
}

// ---- 成契 ----
phase("成契")
if (hasExplicitContract && explicitContractMatchesState) {
  // 同一显式合同(验收语义一致)重跑:账本进度续跑;但合同元数据(complexity/
  // title/problem/goal)按本次注入重建——元数据有意不入指纹,用户只调档位或
  // 措辞时进度保留、新策略立即生效。
  const provided = options.contract
  const prevContract = previousState.contract || {}
  context.criteria = previousState.criteria
  context.conventionsBrief = previousState.conventionsBrief || ""
  // 非指纹元数据:显式提供才覆盖,缺省沿用旧合同——只传 criteria 的注入
  // 不应把旧 standard 意外降成按标准数默认的 simple。
  context.contract = {
    title:
      provided.title !== undefined
        ? String(provided.title)
        : String(prevContract.title || "外部合同"),
    problem:
      provided.problem !== undefined
        ? String(provided.problem)
        : String(prevContract.problem || requirement),
    goal: provided.goal !== undefined ? String(provided.goal) : String(prevContract.goal || ""),
    complexity:
      provided.complexity !== undefined
        ? String(provided.complexity)
        : String(prevContract.complexity || ""),
    nonGoals: asStringArray(provided.nonGoals),
    constraints: asStringArray(provided.constraints),
    conventions: asStringArray(provided.conventions),
    globalValidationCommands: asStringArray(provided.globalValidationCommands),
    criteria: explicitCriteria.map(({ id, text, verify, hint }) => ({ id, text, verify, hint })),
    openQuestions: [],
    canProceed: true,
    proceedReason: "使用外部注入的合同(与状态指纹一致,账本续跑)。"
  }
  log("显式合同与状态指纹一致:按同一合同续跑账本(未完成标准继续,已证实跳过;元数据按本次注入生效)。")
} else if (hasExplicitContract) {
  // 支持在聊天里人机协商好合同后直接注入（成契前置到对话，是人工投入价值最高的一段）。
  // 显式注入的新合同优先于续跑复用:必须按新合同验收,账本重建。
  if (canReuse) {
    log("检测到显式注入的新合同(指纹与状态不一致):忽略旧合同,账本按新合同重建。")
  }
  const provided = options.contract
  context.criteria = explicitCriteria
  context.contract = {
    title: String(provided.title || "外部合同"),
    problem: String(provided.problem || requirement),
    goal: String(provided.goal || ""),
    complexity: String(provided.complexity || ""),
    nonGoals: asStringArray(provided.nonGoals),
    constraints: asStringArray(provided.constraints),
    conventions: asStringArray(provided.conventions),
    globalValidationCommands: asStringArray(provided.globalValidationCommands),
    // 探索/规划的 prompt 依赖 contract 携带标准全文,外部路径同样要带上。
    criteria: context.criteria.map(({ id, text, verify, hint }) => ({ id, text, verify, hint })),
    openQuestions: [],
    canProceed: true,
    proceedReason: "使用外部注入的合同。"
  }
  log(`使用外部注入合同：${context.criteria.length} 条验收标准。`)
} else if (
  canReuse &&
  previousState.contract &&
  Array.isArray(previousState.criteria) &&
  previousState.criteria.length > 0
) {
  context.contract = previousState.contract
  context.criteria = previousState.criteria
  context.conventionsBrief = previousState.conventionsBrief || ""
  log("续跑：复用已有交付合同与验收账本。")
} else {
  const contract = await agent(
    `请把下面的开发需求固化为一份"交付合同"。合同的核心是验收标准清单（criteria）：
- 必须把需求里每个可独立核查的承诺拆成一条标准，宁细勿粗（"五类事件都要记录 IP"应拆成每类事件一条）。
- 每条标准给出核查方式 verify：command（跑命令看结果）、code（读代码给文件:行号证据）、test（对应测试必须存在且通过）、e2e（启动应用用浏览器自动化实测——前端页面、交互、视觉类标准必须用 e2e，不允许用 code 代替）。
- 评定复杂度 complexity：simple（1-3 条标准、单模块小改动）、standard（跨少数模块）、complex（跨多模块、需要多轮实现验证）。
- conventions 写跨任务公约：统一入口、命名、错误码风格等，防止多个实现代理各写各的。
- 如果缺少关键业务规则或安全边界，将 canProceed 设为 false 并列出 openQuestions，不要编造。

需求内容：
${requirement}`,
    {
      label: "需求成契",
      phase: "成契",
      agentType: "Plan",
      schema: CONTRACT_SCHEMA
    }
  )
  if (!contract || !contract.canProceed) {
    const report = `# 契约交付已阻塞

## 原始需求

${requirement}

## 阻塞原因

${contract ? contract.proceedReason : "成契代理没有返回结构化结果。"}

## 待确认项

${contract ? lines(contract.openQuestions) : "- 成契失败"}
`
    await writeFile(outputPath, report)
    context.contract = contract
    await writeState(
      context,
      "contract_blocked",
      contract ? contract.proceedReason : "成契失败",
      contract ? contract.openQuestions : ["成契失败"]
    )
    return {
      状态: "已阻塞",
      报告路径: outputPath,
      待确认项: contract ? contract.openQuestions : ["成契失败"]
    }
  }
  context.contract = contract
  context.criteria = normalizeCriteria(contract.criteria)
  if (context.criteria.length === 0) {
    // schema 的 minLength:1 拦不住纯空白文本;normalize 剔除后为 0 条时必须硬性
    // 失败,否则 every() 空真会直接"可交付 0/0"。与外部合同路径的防线对齐。
    throw new Error("成契产出的合同没有任何有效验收标准（全部为空白文本），请重试或补充需求。")
  }
  log(`合同成立：${context.criteria.length} 条验收标准。`)
}

// 档位自适应：simple 档跳过规划代理与多视角探索（简单需求不为仪式感付费），
// 逐条裁决/对抗复核/终审核对三个质量机制各只有一次调用，任何档位都保留。
const complexityRaw =
  typeof options.complexity === "string"
    ? options.complexity
    : (context.contract && context.contract.complexity) || ""
// 非法值必须报错:拼写错误(如 standrad)静默走自动档会隐性跳过规划/多视角
// 探索,属于无声的行为变化;缺省(空串)才允许自动判档。
if (complexityRaw && !["simple", "standard", "complex"].includes(complexityRaw)) {
  throw new Error(
    `complexity 取值非法:"${complexityRaw}",只接受 simple | standard | complex(或留空自动判档)。`
  )
}
const complexity = ["simple", "standard", "complex"].includes(complexityRaw)
  ? complexityRaw
  : context.criteria.length <= 3
    ? "simple"
    : "standard"
log(`复杂度档位：${complexity}`)

// 任何来源的合同定稿后计算指纹并随状态持久化,供下次显式注入比对。
context.contractFingerprint = contractFingerprintOf(context.criteria, context.contract || {})

if (forceAcIds.length > 0) {
  for (const id of forceAcIds) {
    const entry = criterionById(context.criteria, id)
    if (entry) {
      entry.status = "unproven"
      entry.evidence = ""
      entry.note = "人工要求重新证实。"
      log(`已重置标准 ${id} 为未证实。`)
    } else {
      log(`forceAcIds 中的 ${id} 不在合同里，已忽略。`)
    }
  }
}

await writeFile(
  artifacts.contract,
  renderContractDoc(context.contract, context.criteria, requirement)
)
await writeState(context, "contract_done", "合同已成立。", [])

// ---- 项目探索 ----
// 注：不在脚本层注入技能——运行时会自动给每个子代理注入技能目录（含 read_only 角色），
// 子代理自己会按需调用相关 SKILL.md，脚本重复注入只会浪费上下文。
phase("项目探索")
// simple 档只做单视角画像:档位升到 standard/complex 时低配画像撑不起规划,
// 必须重新完整探索;其余方向(同档/降档)复用更丰富的画像是安全的。
// 旧状态无 explorationComplexity 字段:从状态中的合同档位回推;连合同档位都
// 没有(极老状态)则视为无法确认,当前非 simple 时保守重探——宁可多花一次
// 探索,不在低配画像上做高档规划。
const priorExplorationTier = reusePriorProgress
  ? previousState.explorationComplexity ||
    (previousState.contract && previousState.contract.complexity) ||
    ""
  : ""
const explorationUpgradeNeeded =
  reusePriorProgress &&
  previousState.exploration &&
  complexity !== "simple" &&
  (priorExplorationTier === "simple" || priorExplorationTier === "")
if (explorationUpgradeNeeded) {
  log(
    priorExplorationTier === "simple"
      ? "档位从 simple 升级:不复用单视角画像,重新进行完整探索。"
      : "旧画像档位无法确认且当前为非 simple 档:保守重探,不复用旧画像。"
  )
}
if (reusePriorProgress && previousState.exploration && !explorationUpgradeNeeded) {
  context.exploration = previousState.exploration
  context.explorationComplexity = previousState.explorationComplexity || ""
  log("续跑：复用已有项目画像。")
} else {
  // 同时扫根目录与一级子目录：前后端同仓（frontend/ + backend/）时两侧清单都要被发现。
  const manifestPatterns = [
    "AGENTS.md",
    "README.md",
    "package.json",
    "*/package.json",
    "pom.xml",
    "*/pom.xml",
    "build.gradle",
    "*/build.gradle",
    "build.gradle.kts",
    "go.mod",
    "*/go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "*/pyproject.toml",
    "requirements.txt",
    "*/requirements.txt",
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
    "*/src/**/*.ts",
    "*/src/**/*.tsx",
    "*/src/**/*.vue",
    "*/src/**/*.java",
    "*/src/**/*.py",
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
  const explorePrompts =
    complexity === "simple"
      ? [
          {
            label: "聚焦",
            prompt:
              "识别本次修改直接涉及的文件、可用的构建/测试命令和主要风险，聚焦即可，不必全面。"
          }
        ]
      : [
          {
            label: "架构",
            prompt: "识别项目类型、关键模块、合同标准最可能触及的文件，以及实现入口。"
          },
          { label: "验证", prompt: "识别可用构建/测试/lint 命令、测试目录、现有验证习惯和风险。" },
          { label: "风险", prompt: "识别兼容性、安全、数据、配置、发布和回滚风险。" }
        ]
  const explorationParts = (
    await parallel(
      explorePrompts.map(
        (item) => () =>
          agent(
            `请只读探索项目，不要修改文件。

探索视角：${item.label}
${item.prompt}

交付合同：
${stringify(context.contract)}

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
  const summaries = []
  const relevantFiles = []
  const testCommands = []
  const buildCommands = []
  const risks = []
  const seenFiles = Object.create(null)
  for (const part of explorationParts) {
    if (part.summary) summaries.push(part.summary)
    for (const file of part.relevantFiles || []) {
      if (!file || !file.path || seenFiles[file.path]) continue
      seenFiles[file.path] = true
      relevantFiles.push(file)
    }
    for (const c of part.testCommands || []) testCommands.push(c)
    for (const c of part.buildCommands || []) buildCommands.push(c)
    for (const r of part.risks || []) risks.push(r)
  }
  context.exploration = {
    summary: summaries.join("\n\n") || "没有获得项目探索摘要。",
    relevantFiles,
    testCommands: uniq(testCommands),
    buildCommands: uniq(buildCommands),
    risks: uniq(risks)
  }
  context.explorationComplexity = complexity
}
await writeFile(artifacts.profile, renderProjectProfile(context.exploration))
await writeState(context, "explore_done", "项目探索已完成。", [])

// ---- 交付循环：每轮只做未证实的标准，直到全部证实或轮次/进度耗尽 ----
phase("交付循环")
let planBlockedExit = null
let roundsThisRun = 0
while (roundsThisRun < maxRounds) {
  const pending = unresolvedCriteria(context.criteria)
  if (pending.length === 0) break
  roundsThisRun += 1
  const round = context.roundsUsed + 1

  let plan = null
  if (complexity === "simple") {
    plan = {
      strategy: "简单需求直通：跳过规划代理，单工作包认领全部待证实标准。",
      conventionsBrief:
        context.conventionsBrief ||
        (context.contract.conventions || []).join("；") ||
        "遵循项目现有代码风格与分层结构。",
      packages: [
        {
          id: `pkg-r${round}`,
          title: "直通实现",
          objective: "实现并证实全部待证实标准。",
          acIds: pending.map((c) => c.id),
          targetFiles: [],
          validationCommands: uniq(context.contract.globalValidationCommands || []),
          dependencies: [],
          riskLevel: "low"
        }
      ],
      canImplement: true,
      blockers: []
    }
    log(`第 ${round} 轮（simple 档）：跳过规划代理，单工作包直通实现。`)
  } else {
    plan = await agent(
      `这是契约交付的第 ${round} 轮。请只为下面"待证实标准"规划工作包（package），已证实的标准不要碰。

交付合同摘要（验收标准以下方"待证实标准"为唯一依据）：
${stringify({
  title: context.contract.title,
  goal: context.contract.goal,
  nonGoals: context.contract.nonGoals,
  constraints: context.contract.constraints,
  conventions: context.contract.conventions,
  globalValidationCommands: context.contract.globalValidationCommands
})}

项目画像：
${stringify(context.exploration)}

待证实标准（含上一轮失败/驳回原因，规划必须针对性回应）：
${stringify(pending)}

${context.conventionsBrief ? `上一轮公约简报（沿用并按需修订）：\n${context.conventionsBrief}\n` : ""}
要求：
- 每个工作包声明它负责证实哪些标准（acIds），粒度小到一个 agent 可以安全完成。
- 每条待证实标准必须被至少一个工作包认领；确实无法认领的，在 blockers 里说明原因。
- conventionsBrief 写一页跨包公约（统一入口/命名/风格），所有实现代理都会收到它。
- 工作包之间如有依赖写 dependencies（用工作包 id）。
- 如果整体无法安全实现，将 canImplement 设为 false 并列出 blockers。`,
      {
        label: `第${round}轮规划`,
        phase: "交付循环",
        agentType: "Plan",
        schema: ROUND_PLAN_SCHEMA
      }
    )
  }

  if (!plan || !plan.canImplement) {
    planBlockedExit = plan ? plan.blockers : ["规划代理没有返回结构化结果。"]
    log(`第 ${round} 轮规划阻塞：${planBlockedExit.join("；")}`)
    break
  }

  context.conventionsBrief = plan.conventionsBrief
  const normalized = normalizePackages(plan.packages, context.criteria)
  if (normalized.droppedAcRefs.length > 0) {
    log("规划引用了不存在的标准，已忽略：" + normalized.droppedAcRefs.join("；"))
  }
  if (normalized.droppedDeps.length > 0) {
    log("规划引用了无法解析的工作包依赖，已忽略：" + normalized.droppedDeps.join("；"))
  }
  let packages = normalized.packages
  // 全部 acIds 均无效的工作包没有任何合同约束,不允许执行——丢弃并告警。
  const emptyAcPackages = packages.filter((pkg) => pkg.acIds.length === 0)
  if (emptyAcPackages.length > 0) {
    log(
      "以下工作包没有任何有效验收标准,已丢弃(规划引用的 AC 无法解析):" +
        emptyAcPackages.map((pkg) => pkg.id).join("、")
    )
    packages = packages.filter((pkg) => pkg.acIds.length > 0)
  }
  // 先对完整包图拓扑排序,再截断:拓扑序前缀是依赖闭包,截断只丢下游包,
  // 不会出现"保留的包依赖被截掉的上游"导致整轮空转误判 needs_fix。
  const sorted = topoSortPackages(packages)
  if (sorted.cyclic) log("工作包依赖存在环，按可行顺序执行。")
  packages = sorted.packages
  if (packages.length > MAX_PACKAGES_PER_ROUND) {
    const dropped = packages.slice(MAX_PACKAGES_PER_ROUND).map((p) => p.id)
    log(
      `工作包超过单轮上限 ${MAX_PACKAGES_PER_ROUND}，已丢弃下游包：${dropped.join("、")}（其标准留待下一轮）`
    )
    packages = packages.slice(0, MAX_PACKAGES_PER_ROUND)
  }

  // 覆盖率硬校验：未被认领的待证实标准记录在案并告警——不允许静默漏项。
  const claimedSet = Object.create(null)
  for (const pkg of packages) for (const id of pkg.acIds) claimedSet[id] = true
  const unclaimed = pending.filter((c) => !claimedSet[c.id]).map((c) => c.id)
  for (const id of unclaimed) {
    const entry = criterionById(context.criteria, id)
    entry.note = `第 ${round} 轮规划未认领该标准。`
  }
  if (unclaimed.length > 0) {
    log(`警告：以下标准本轮未被任何工作包认领：${unclaimed.join("、")}`)
  }
  await writeFile(
    joinPath(artifactDir, `rounds/round-${round}/规划.md`),
    renderRoundPlanDoc(
      round,
      { ...plan, packages },
      {
        target: pending.map((c) => c.id),
        claimed: pending.filter((c) => claimedSet[c.id]).map((c) => c.id),
        unclaimed
      }
    )
  )

  const packageOutcome = Object.create(null)
  for (const pkg of packages) {
    const unmetDeps = (pkg.dependencies || []).filter((dep) => packageOutcome[dep] !== "ok")
    if (unmetDeps.length > 0) {
      const reason = `依赖工作包未就绪：${unmetDeps.join("、")}`
      log(`工作包 ${pkg.title} 已跳过：${reason}`)
      packageOutcome[pkg.id] = "blocked"
      for (const id of pkg.acIds) {
        const entry = criterionById(context.criteria, id)
        if (entry.status !== "proven") entry.note = reason
      }
      continue
    }

    const pkgCriteria = pkg.acIds.map((id) => criterionById(context.criteria, id))
    const implementation =
      (await agent(
        `请实现当前工作包。只做这个工作包，不要扩大范围。

交付合同摘要（标题/目标/非目标/约束）：
${stringify({
  title: context.contract.title,
  goal: context.contract.goal,
  nonGoals: context.contract.nonGoals,
  constraints: context.contract.constraints
})}

公约简报（必须遵守，防止与其他工作包风格漂移）：
${context.conventionsBrief}

项目画像：
${stringify(context.exploration)}

当前工作包：
${stringify(pkg)}
（提示：如果你的可用技能里有与本工作包领域相关的技能，优先遵循其指引。）

你要证实的验收标准（实现必须逐条对得上，注意每条的核查方式和失败备注）：
${stringify(pkgCriteria)}

执行要求：
- 做最小且正确的修改；变更后尽量运行工作包的验证命令。
- 如果标准带有上一轮的失败/驳回备注，必须针对性修复。
- 如果无法安全完成，返回 status=blocked 并列出阻塞项。`,
        {
          label: `实现R${round}：${pkg.title}`,
          phase: "交付循环",
          schema: IMPLEMENTATION_SCHEMA
        }
      )) || fallbackImplementation("实现代理没有返回结构化结果。")

    let verification =
      implementation.status === "blocked"
        ? fallbackVerification("实现阶段已阻塞，未运行验证。", pkg.acIds)
        : enforcePerAcCompleteness(
            (await agent(
              `请独立验证当前工作包，逐条裁决验收标准。不要修改文件。

当前工作包：
${stringify(pkg)}

逐条验收标准（perAc 必须覆盖每一条 id，pass 必须给证据：文件:行号或命令输出摘录）：
${stringify(pkgCriteria)}

实现结果：
${stringify(implementation)}

建议验证命令：
${lines(pkg.validationCommands)}

请实际运行可用命令，对每条标准按其核查方式取证，并至少尝试一个边界/反例。
工作包声明的验证命令必须逐条执行,commandChecks.command 原样填写声明的命令字符串。
特别注意 verify=e2e 的标准：必须实际启动应用，用浏览器自动化工具导航/点击/截图取证；
如果当前没有可用的浏览器自动化工具，如实返回 unclear 并在证据里说明——严禁用"代码看起来正确"充当 e2e 证据。`,
              {
                label: `验证R${round}：${pkg.title}`,
                phase: "交付循环",
                agentType: "verification",
                schema: PACKAGE_VERIFY_SCHEMA
              }
            )) || fallbackVerification("验证代理没有返回结构化结果。", pkg.acIds),
            pkg
          )

    let fix = null
    let fixRound = 0
    while (
      verification.perAc.some((p) => p.result !== "pass") &&
      implementation.status !== "blocked" &&
      fixRound < maxFixRounds
    ) {
      fixRound += 1
      const previousFix = fix
      const failing = verification.perAc.filter((p) => p.result !== "pass")
      fix =
        (await agent(
          `第 ${fixRound} 轮聚焦修复。只修复未通过的标准，不要扩大范围。

公约简报：
${context.conventionsBrief}

当前工作包：
${stringify(pkg)}

首轮实现：
${stringify(implementation)}
${previousFix ? `\n上一轮修复（当前代码已包含这些修改）：\n${stringify(previousFix)}\n` : ""}
未通过的标准及证据：
${stringify(failing)}

如果无法安全修复，返回 status=blocked。`,
          {
            label: `修复R${round}：${pkg.title} #${fixRound}`,
            phase: "交付循环",
            schema: IMPLEMENTATION_SCHEMA
          }
        )) || fallbackImplementation("修复代理没有返回结构化结果。")
      if (fix.status === "blocked") break
      verification = enforcePerAcCompleteness(
        (await agent(
          `修复后复验，逐条裁决验收标准。不要修改文件。

当前工作包：
${stringify(pkg)}

逐条验收标准：
${stringify(pkgCriteria)}

修复结果：
${stringify(fix)}

上一次逐条结论：
${stringify(verification.perAc)}

perAc 必须逐条覆盖工作包的每一条标准(含之前已通过的,漏报会被判失败);
工作包声明的验证命令必须逐条执行,commandChecks.command 原样填写声明的命令字符串。
复验重点放在之前未通过的标准上。`,
          {
            label: `复验R${round}：${pkg.title} #${fixRound}`,
            phase: "交付循环",
            agentType: "verification",
            schema: PACKAGE_VERIFY_SCHEMA
          }
        )) || fallbackVerification("复验代理没有返回结构化结果。", pkg.acIds),
        pkg
      )
    }

    for (const per of verification.perAc) {
      const entry = criterionById(context.criteria, per.id)
      if (!entry) continue
      if (per.result === "pass") {
        entry.status = "proven"
        entry.evidence = per.evidence
        entry.note = ""
        entry.round = round
      } else {
        entry.status = "unproven"
        entry.note = `第 ${round} 轮验证未通过：${per.evidence}`
      }
    }
    context.changedFiles = uniq([
      ...context.changedFiles,
      ...(implementation.changedFiles || []),
      ...((fix && fix.changedFiles) || [])
    ])
    packageOutcome[pkg.id] =
      implementation.status === "blocked" || (fix && fix.status === "blocked")
        ? "blocked"
        : verification.perAc.every((p) => p.result === "pass")
          ? "ok"
          : "partial"
    await writeFile(
      joinPath(artifactDir, `rounds/round-${round}/packages/${pkg.id}.md`),
      renderPackageDoc(pkg, implementation, fix, verification)
    )
    await writeState(
      context,
      "round_running",
      `第 ${round} 轮：工作包 ${pkg.id} 完成（${packageOutcome[pkg.id]}）。`,
      []
    )
  }

  // 对抗复核：由独立代理专职推翻本轮新证实的标准，防止自评式放行。
  const newlyProven = context.criteria.filter((c) => c.status === "proven" && c.round === round)
  if (newlyProven.length > 0) {
    const audit = await agent(
      `你是对抗复核代理。你的唯一任务是推翻下面这些"已证实"的验收标准——逐条检查证据是否真实、充分、与标准语义一致（证据可以在代码库里核实，必要时运行只读命令）。
宁可错杀不可放过：证据模糊、以偏概全、文件行号对不上的，一律驳回。确实无懈可击的才放行。不要修改文件。

本轮新证实的标准与证据：
${stringify(newlyProven.map((c) => ({ id: c.id, text: c.text, verify: c.verify, evidence: c.evidence })))}

对每条要驳回的标准，给出 id 和具体驳回理由。`,
      {
        label: `对抗复核R${round}`,
        phase: "交付循环",
        agentType: "verification",
        schema: AUDIT_SCHEMA
      }
    )
    for (const refutation of (audit && audit.refutations) || []) {
      const entry = criterionById(
        context.criteria,
        String(refutation.id || "")
          .trim()
          .toUpperCase()
      )
      if (entry && entry.status === "proven" && entry.round === round) {
        entry.status = "refuted"
        entry.note = `第 ${round} 轮对抗复核驳回：${refutation.reason}`
        log(`对抗复核驳回 ${entry.id}：${refutation.reason}`)
      }
    }
  }

  context.roundsUsed = round
  const provenCount = context.criteria.filter((c) => c.status === "proven").length
  const spentSoFar = tokensSpent()
  log(
    `第 ${round} 轮结束：${provenCount}/${context.criteria.length} 条标准已证实。` +
      (spentSoFar != null ? `（累计输出 ${spentSoFar} tokens）` : "")
  )
  await writeState(context, "round_done", `第 ${round} 轮结束。`, [])

  // 进度守卫：一轮下来没有任何新证实（含被驳回后的净值），说明在空转，停下来如实报告。
  if (newlyProven.filter((c) => c.status === "proven").length === 0) {
    log("本轮没有任何标准被证实，停止循环以避免空转。")
    break
  }
}

// ---- 终审：独立执行代理重跑全局验证命令，交叉核对，防证据造假 ----
// 只要合同定义了全局验证命令就必须执行——不看 changedFiles：实现代理可能漏填
// 变更清单,"无需修改"的需求也同样要证明全局验证仍然通过,静默跳过等于误报。
phase("终审")
let runnerResult = null
const globalCommands = uniq(context.contract.globalValidationCommands || [])
if (globalCommands.length > 0) {
  const runner = await agent(
    `请逐条执行以下命令并如实报告结果,command 字段原样填写清单中的命令字符串。你只负责执行和报告，不做任何判断修饰，不要修改文件。
每条命令报告：是否成功（passed，以退出码为准），以及关键输出摘录（evidence）。

命令清单：
${lines(globalCommands)}`,
    {
      label: "终审命令核对",
      phase: "终审",
      agentType: "verification",
      schema: RUNNER_SCHEMA
    }
  )
  if (runner) {
    // 代码层交叉核对：每条要求的命令必须出现在结果里，缺失按失败计。
    const reported = Object.create(null)
    for (const c of runner.commands || []) {
      const key = normalizeCommandText(c.command)
      const existing = reported[key]
      // 重复上报聚合取"最坏":失败条目不被后续成功条目覆盖。
      if (!existing || existing.passed === true) reported[key] = c
    }
    const commands = globalCommands.map(
      (cmd) =>
        reported[normalizeCommandText(cmd)] || {
          command: cmd,
          passed: false,
          evidence: "终审代理未执行该命令。"
        }
    )
    // 终审代理如实报告的"清单外失败命令"不可丢弃——发现了问题就必须计入裁决。
    const declaredNormalized = globalCommands.map(normalizeCommandText)
    const extraFailed = (runner.commands || []).filter(
      (item) =>
        !declaredNormalized.includes(normalizeCommandText(item.command)) && item.passed === false
    )
    runnerResult = { summary: runner.summary, commands: [...commands, ...extraFailed] }
  } else {
    runnerResult = {
      summary: "终审代理没有返回结构化结果。",
      commands: globalCommands.map((cmd) => ({ command: cmd, passed: false, evidence: "未执行。" }))
    }
  }
} else {
  log("合同未定义全局验证命令，跳过终审命令核对。")
}

// ---- 交付报告 ----
phase("交付报告")
context.tokensOut = tokensSpent()
const provenAll = context.criteria.every((c) => c.status === "proven")
const runnerOk = !runnerResult || runnerResult.commands.every((c) => c.passed)
let verdict
let verdictReason
if (planBlockedExit) {
  verdict = "blocked"
  verdictReason = `规划阶段阻塞：${planBlockedExit.join("；")}`
} else if (provenAll && runnerOk) {
  verdict = "ready"
  verdictReason = `全部 ${context.criteria.length} 条验收标准均有证据${
    runnerResult ? "，终审命令核对通过" : "（合同未定义全局验证命令，未执行终审核对）"
  }。`
} else {
  verdict = "needs_fix"
  const pendingIds = unresolvedCriteria(context.criteria).map((c) => c.id)
  verdictReason = [
    pendingIds.length > 0 ? `未证实标准：${pendingIds.join("、")}。` : "",
    !runnerOk ? "终审命令存在失败项。" : "",
    "用同一需求文本重跑即可续跑（只处理未证实标准）。"
  ]
    .filter(Boolean)
    .join(" ")
}
await writeFile(outputPath, renderDeliveryReport(context, verdict, runnerResult, verdictReason))
await writeState(
  context,
  verdict === "ready" ? "delivered" : "needs_fix",
  verdictReason,
  planBlockedExit || []
)

return {
  状态: statusText(verdict),
  标题: context.contract.title,
  报告路径: outputPath,
  产物目录: artifactDir,
  轮次: context.roundsUsed,
  输出token: context.tokensOut,
  验收标准总数: context.criteria.length,
  已证实: context.criteria.filter((c) => c.status === "proven").length,
  未证实: unresolvedCriteria(context.criteria).map((c) => `${c.id}：${c.note || c.text}`),
  终审: runnerResult
    ? runnerResult.commands.map((c) => `${c.command} → ${c.passed ? "通过" : "失败"}`)
    : ["未执行"],
  变更文件: take(context.changedFiles, MAX_CHANGED_FILES),
  说明: verdictReason
}
