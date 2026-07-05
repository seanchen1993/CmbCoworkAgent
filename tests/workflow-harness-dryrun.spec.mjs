/**
 * Behavioral dry-run suite for docs/workflows/auto-dev-harness.workflow.js — mocks the workflow
 * sandbox globals (agent/parallel/phase/log/glob/readFile/writeFile) and runs
 * the REAL script end-to-end across scenarios (resume, gating, hard gates,
 * cascade invalidation...). Assertions print PASS/FAIL lines; any FAIL makes
 * the process exit non-zero so CI hard-fails.
 *
 * Run:
 *   npx tsx tests/workflow-harness-dryrun.spec.mjs
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let dryrunFailures = 0
const rawLog = console.log
console.log = (...args) => {
  if (args.some((a) => typeof a === "string" && /^FAIL/.test(a))) dryrunFailures += 1
  rawLog(...args)
}

let src = fs.readFileSync(
  path.join(__dirname, "..", "docs", "workflows", "auto-dev-harness.workflow.js"),
  "utf8"
)
src = src.replace(/^export const meta/m, "const meta")

const runScript = new Function(
  "agent",
  "parallel",
  "phase",
  "log",
  "args",
  "glob",
  "readFile",
  "writeFile",
  '"use strict"; return (async () => {' + src + "})()"
)

function makeEnv({ files, agentBehavior, logs }) {
  const agent = async (prompt, opts) => {
    const label = (opts && opts.label) || ""
    logs.push("AGENT: " + label)
    return agentBehavior(label, prompt)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const phase = (t) => logs.push("PHASE: " + t)
  const log = (m) => logs.push("LOG: " + m)
  const glob = async () => []
  const readFile = async (p) => {
    if (!(p in files)) throw new Error("ENOENT: " + p)
    return files[p]
  }
  const writeFile = async (p, c) => {
    files[p] = c
  }
  return { agent, parallel, phase, log, glob, readFile, writeFile }
}

const NORMALIZED = {
  title: "测试需求标题",
  problem: "p",
  goal: "g",
  nonGoals: [],
  acceptanceCriteria: ["验收1"],
  constraints: [],
  risks: [],
  openQuestions: [],
  canProceed: true,
  proceedReason: "信息充分"
}
const EXPLORE = {
  summary: "小型项目",
  relevantFiles: [],
  testCommands: ["npm test"],
  buildCommands: [],
  risks: []
}
// 规划故意把 B 放前面且 B 依赖 A（用原始 id 大写形式测重映射），验证拓扑排序 + 依赖重映射
const PLAN = {
  strategy: "先 A 后 B",
  tasks: [
    {
      id: "Task B",
      title: "任务B",
      objective: "b",
      why: "w",
      targetFiles: [],
      acceptanceCriteria: ["b ok"],
      validationCommands: [],
      dependencies: ["Task A", "ghost-task"],
      riskLevel: "low"
    },
    {
      id: "Task A",
      title: "任务A",
      objective: "a",
      why: "w",
      targetFiles: [],
      acceptanceCriteria: ["a ok"],
      validationCommands: [],
      dependencies: [],
      riskLevel: "low"
    }
  ],
  globalValidationCommands: ["npm test"],
  blockers: [],
  canImplement: true
}
const IMPL_OK = {
  status: "changed",
  summary: "改好了",
  changedFiles: ["src/x.ts"],
  commandsRun: [],
  blockers: [],
  notes: []
}
// 注意:验收检查必须逐条覆盖任务验收标准(本套件的任务都恰好 1 条标准),
// 空 acceptanceChecks 的 pass 会被一致性门禁降级——那是场景 9 专门测的路径。
const VERIFY_PASS = {
  status: "pass",
  summary: "通过",
  commandChecks: [],
  acceptanceChecks: [{ id: "AC-1", criterion: "任务验收标准", result: "pass", evidence: "已核查" }],
  issues: [],
  recommendedFixes: []
}
const VERIFY_FAIL = {
  status: "fail",
  summary: "失败",
  commandChecks: [],
  acceptanceChecks: [],
  issues: ["边界未处理"],
  recommendedFixes: ["补边界"]
}
const FINAL_READY = {
  verdict: "ready",
  summary: "整体通过",
  acceptanceCoverage: [{ id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }],
  commandChecks: [{ command: "npm test", result: "pass", evidence: "suite ok" }],
  releaseNotes: ["发布1"],
  remainingIssues: [],
  nextActions: []
}

async function scenario1and2() {
  const files = {}
  let verifyBFirst = true
  const behavior = (label, prompt) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") return PLAN
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：任务B")) {
      if (verifyBFirst) {
        verifyBFirst = false
        return VERIFY_FAIL
      }
      return VERIFY_PASS
    }
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label.startsWith("修复：")) {
      // 第二轮修复的 prompt 应包含"上一轮修复"字样 —— 这里只有一轮，检查首轮不包含
      if (label.includes("#1") && prompt.includes("上一轮修复"))
        throw new Error("首轮修复不应带上一轮修复上下文")
      return IMPL_OK
    }
    if (label.startsWith("复验：")) return VERIFY_PASS
    if (label === "总体验收") return FINAL_READY
    throw new Error("未知 agent label: " + label)
  }

  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: behavior, logs: logs1 })
  const r1 = await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    "给项目加一个测试需求功能",
    env1.glob,
    env1.readFile,
    env1.writeFile
  )

  console.log("== 场景1 全新运行 ==")
  console.log("返回状态:", r1.状态, "| 任务数:", r1.任务数, "| 已完成:", r1.已完成任务数)
  console.log("首跑最终可交付:", r1.状态 === "可交付" ? "PASS" : "FAIL " + r1.状态)
  const agentCalls1 = logs1.filter((l) => l.startsWith("AGENT")).length
  console.log("agent 调用次数:", agentCalls1)
  // 拓扑排序断言：实现A 必须在 实现B 之前
  const idxA = logs1.findIndex((l) => l === "AGENT: 实现：任务A")
  const idxB = logs1.findIndex((l) => l === "AGENT: 实现：任务B")
  console.log("拓扑排序(A先于B):", idxA >= 0 && idxB > idxA ? "PASS" : "FAIL " + idxA + "/" + idxB)
  console.log(
    "幽灵依赖被剔除并告警:",
    logs1.some((l) => l.includes("无法解析的任务依赖") && l.includes("ghost-task"))
      ? "PASS"
      : "FAIL"
  )
  console.log("修复循环触发:", logs1.some((l) => l === "AGENT: 修复：任务B #1") ? "PASS" : "FAIL")
  const state = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/给项目加一个测试需求功能/状态.json"] || "null"
  )
  console.log(
    "状态文件存在且含 plan/normalized/exploration:",
    state && state.plan && state.normalized && state.exploration ? "PASS" : "FAIL"
  )
  console.log("状态文件 checkpoint:", state && state.checkpoint)

  // 场景2：同一需求续跑（files 保留）
  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    "给项目加一个测试需求功能",
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  console.log("\n== 场景2 续跑 ==")
  console.log("返回状态:", r2.状态, "| 已完成:", r2.已完成任务数)
  console.log("续跑最终可交付:", r2.状态 === "可交付" ? "PASS" : "FAIL " + r2.状态)
  console.log("复用需求契约:", logs2.some((l) => l.includes("复用已有需求契约")) ? "PASS" : "FAIL")
  console.log("复用项目画像:", logs2.some((l) => l.includes("复用已有项目画像")) ? "PASS" : "FAIL")
  console.log("复用任务规划:", logs2.some((l) => l.includes("复用已有任务规划")) ? "PASS" : "FAIL")
  console.log(
    "跳过已完成任务:",
    logs2.filter((l) => l.includes("跳过已完成任务")).length === 2 ? "PASS" : "FAIL"
  )
  const agentCalls2 = logs2.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  console.log(
    "续跑仅剩总体验收调用:",
    JSON.stringify(agentCalls2) === JSON.stringify(["总体验收"])
      ? "PASS"
      : "FAIL " + JSON.stringify(agentCalls2)
  )
}

async function scenario3() {
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") return PLAN
    if (label === "实现：任务A") return { ...IMPL_OK, status: "blocked", blockers: ["无法实现"] }
    if (label === "实现：任务B") throw new Error("任务B 不应被实现——依赖 A 已阻塞")
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "blocked",
        summary: "有阻塞",
        releaseNotes: [],
        remainingIssues: ["A 阻塞"],
        nextActions: ["人工介入"]
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "依赖门控测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景3 依赖门控 ==")
  console.log("返回状态:", r.状态)
  console.log(
    "任务B 被依赖门控阻塞:",
    logs.some((l) => l.includes("任务 任务B 已阻塞") && l.includes("依赖任务未就绪"))
      ? "PASS"
      : "FAIL"
  )
  const taskBState = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/依赖门控测试需求/tasks/task-a/任务状态.json"] || "null"
  )
  console.log(
    "任务A 状态 blocked:",
    taskBState && taskBState.status === "blocked" ? "PASS" : "FAIL " + JSON.stringify(taskBState)
  )
}

async function scenario4() {
  // 自定义 outputPath + 需求阻塞路径：报告必须写到 outputPath
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理")
      return {
        ...NORMALIZED,
        canProceed: false,
        proceedReason: "缺少关键信息",
        openQuestions: ["Q1"]
      }
    throw new Error("不应到达: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    { requirement: "模糊需求", outputPath: "custom/报告.md", artifactDir: "custom-dir" },
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景4 需求阻塞 + 自定义路径 ==")
  console.log("返回状态:", r.状态, "| 报告路径:", r.报告路径)
  console.log(
    "报告写到自定义 outputPath:",
    files["custom/报告.md"] ? "PASS" : "FAIL, 实际写入: " + Object.keys(files).join(", ")
  )
  console.log("状态文件写到 artifactDir:", files["custom-dir/状态.json"] ? "PASS" : "FAIL")
}

// ===== 场景5:replan:true 重新规划后,旧任务状态不得污染报告 =====
async function scenario5() {
  const files = {}
  let planCalls = 0
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") {
      planCalls += 1
      if (planCalls === 1) return PLAN // 首跑:task-a + task-b
      return {
        // replan:换成全新的单任务计划
        strategy: "s2",
        tasks: [
          {
            id: "task-c",
            title: "任务C",
            objective: "c",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["c ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    }
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "ok",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: behavior, logs: logs1 })
  await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    "replan测试需求",
    env1.glob,
    env1.readFile,
    env1.writeFile
  )

  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "replan测试需求", replan: true },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  console.log("\n== 场景5 replan 不污染状态 ==")
  console.log(
    "旧任务被移除并告警:",
    logs2.some((l) => l.includes("旧任务") && l.includes("task-a")) ? "PASS" : "FAIL"
  )
  console.log(
    "报告只含新计划任务(1个):",
    r2.任务数 === 1 && r2.已完成任务数 === 1 ? "PASS" : "FAIL " + r2.任务数 + "/" + r2.已完成任务数
  )
}

// ===== 场景6:总体验收误报 ready 时,硬门禁强制降级 =====
async function scenario6() {
  const files = {}
  const logs = []
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") return PLAN
    if (label === "实现：任务A") return { ...IMPL_OK, status: "blocked", blockers: ["无法实现"] }
    if (label === "实现：任务B") throw new Error("任务B 不应被实现")
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      } // 故意误报 ready
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "硬门禁测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景6 最终裁决硬门禁 ==")
  console.log("误报 ready 被降级:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "降级原因写入剩余问题:",
    (r.剩余问题 || []).some((s) => s.includes("未完成任务")) ? "PASS" : "FAIL"
  )
  console.log("降级有日志:", logs.some((l) => l.includes("硬门禁降级")) ? "PASS" : "FAIL")
}

// ===== 场景7:forceTaskIds 沿依赖传递失效下游 ready 任务 =====
async function scenario7() {
  const files = {}
  // 独立 plan 对象:共享的 PLAN 常量会被脚本执行原地改写(plan.tasks 重排),跨场景复用会串味
  const freshPlan = () => ({
    strategy: "s",
    tasks: [
      {
        id: "Task B",
        title: "任务B",
        objective: "b",
        why: "w",
        targetFiles: [],
        acceptanceCriteria: ["b ok"],
        validationCommands: [],
        dependencies: ["Task A"],
        riskLevel: "low"
      },
      {
        id: "Task A",
        title: "任务A",
        objective: "a",
        why: "w",
        targetFiles: [],
        acceptanceCriteria: ["a ok"],
        validationCommands: [],
        dependencies: [],
        riskLevel: "low"
      }
    ],
    globalValidationCommands: [],
    blockers: [],
    canImplement: true
  })
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") return freshPlan() // task-b 依赖 task-a
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "ok",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: behavior, logs: logs1 })
  await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    "传递失效测试需求",
    env1.glob,
    env1.readFile,
    env1.writeFile
  )

  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "传递失效测试需求", forceTaskIds: ["Task A", "不存在的任务"] }, // 原始未规范化 id + 未知输入
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  const calls = logs2.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  console.log("\n== 场景7 强制重跑传递失效 ==")
  console.log(
    "传递失效有日志:",
    logs2.some((l) => l.includes("连带重跑") && l.includes("task-b")) ? "PASS" : "FAIL"
  )
  console.log(
    "下游任务B 连带重跑:",
    calls.includes("实现：任务B") ? "PASS" : "FAIL " + JSON.stringify(calls)
  )
  console.log("重跑后仍 ready:", r2.状态 === "可交付" ? "PASS" : "FAIL")
  console.log(
    "原始输入被归一化匹配(A 真的重跑了):",
    calls.includes("实现：任务A") ? "PASS" : "FAIL"
  )
  console.log(
    "未知输入被显式告警:",
    logs2.some((l) => l.includes("无法匹配任何计划任务") && l.includes("不存在的任务"))
      ? "PASS"
      : "FAIL"
  )
}

// ===== 场景8:验证结论自相矛盾(总体 pass 但验收项 fail)被代码强制降级 =====
async function scenario8() {
  const files = {}
  const contradictoryVerify = () => ({
    status: "pass", // 总体谎报通过
    summary: "看起来都好",
    commandChecks: [],
    acceptanceChecks: [{ id: "AC-1", criterion: "a ok", result: "fail", evidence: "断言失败" }],
    issues: [],
    recommendedFixes: []
  })
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-x",
            title: "任务X",
            objective: "x",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["a ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：") || label.startsWith("修复：")) return IMPL_OK
    if (label.startsWith("验证：") || label.startsWith("复验：")) return contradictoryVerify()
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "矛盾验证测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  const calls = logs.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  console.log("\n== 场景8 矛盾验证降级 ==")
  console.log(
    "矛盾输出触发修复循环:",
    calls.includes("修复：任务X #1") ? "PASS" : "FAIL " + JSON.stringify(calls)
  )
  console.log("任务最终非 ready:", r.已完成任务数 === 0 ? "PASS" : "FAIL")
  console.log("整体被硬门禁压为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  const state = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/矛盾验证测试需求/状态.json"] || "null"
  )
  const taskIssues = JSON.stringify((state && state.tasks) || [])
  console.log("矛盾降级理由入账:", taskIssues.includes("已由代码强制降级") ? "PASS" : "FAIL")
}

// ===== 场景9:总体 pass 但验收检查为空(偷懒输出)被代码强制降级 =====
async function scenario9() {
  const files = {}
  const lazyVerify = () => ({
    status: "pass", // 谎报通过但一条验收都没核查
    summary: "都挺好",
    commandChecks: [],
    acceptanceChecks: [],
    issues: [],
    recommendedFixes: []
  })
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-y",
            title: "任务Y",
            objective: "y",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["y ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：") || label.startsWith("修复：")) return IMPL_OK
    if (label.startsWith("验证：") || label.startsWith("复验：")) return lazyVerify()
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "空验收检查测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景9 空验收检查降级 ==")
  console.log("任务未被标 ready:", r.已完成任务数 === 0 ? "PASS" : "FAIL")
  console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  const state = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/空验收检查测试需求/状态.json"] || "null"
  )
  const taskIssues = JSON.stringify((state && state.tasks) || [])
  console.log("未逐条覆盖理由入账:", taskIssues.includes("未逐条覆盖") ? "PASS" : "FAIL")
}

// ===== 场景10:重复返回同一条验收标准冒充覆盖数量 → 去重后被降级 =====
async function scenario10() {
  const files = {}
  const irrelevantVerify = () => ({
    status: "pass",
    summary: "都好",
    commandChecks: [],
    // 数量够、全 pass、证据非空——但 AC-2(记录登出 IP)没被覆盖,第二条是清单外无关项
    acceptanceChecks: [
      { id: "AC-1", criterion: "记录登录 IP", result: "pass", evidence: "核查1" },
      { id: "AC-99", criterion: "新增日志表", result: "pass", evidence: "核查2" }
    ],
    issues: [],
    recommendedFixes: []
  })
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-z",
            title: "任务Z",
            objective: "z",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["记录登录 IP", "记录登出 IP"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：") || label.startsWith("修复：")) return IMPL_OK
    if (label.startsWith("验证：") || label.startsWith("复验：")) return irrelevantVerify()
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "重复冒充测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景10 无关项凑数被 ID 对齐降级 ==")
  console.log("任务未被标 ready:", r.已完成任务数 === 0 ? "PASS" : "FAIL")
  console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  const state = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/重复冒充测试需求/状态.json"] || "null"
  )
  const taskIssues = JSON.stringify((state && state.tasks) || [])
  console.log(
    "缺失 AC-2 被点名入账:",
    taskIssues.includes("AC-2") && taskIssues.includes("未逐条覆盖") ? "PASS" : "FAIL"
  )
}

// ===== 场景11:任务全 ready 但全局验证命令漏报/失败 → 硬门禁降级 =====
async function scenario11() {
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-w",
            title: "任务W",
            objective: "w",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["w ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: ["npm test", "npm run lint"],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      // 误报 ready:只报了一条命令,漏掉 npm run lint
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        commandChecks: [{ command: "npm test", result: "pass", evidence: "ok" }],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "全局命令漏报测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景11 全局命令漏报被降级 ==")
  console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "漏报命令被点名:",
    logs.some((l) => l.includes("硬门禁降级") && l.includes("npm run lint")) ? "PASS" : "FAIL"
  )
  console.log(
    "剩余问题含命令原因:",
    (r.剩余问题 || []).some((s2) => s2.includes("npm run lint")) ? "PASS" : "FAIL"
  )

  // 11b: 全局命令为空,但终审如实报告了一条清单外失败命令 → 同样降级
  {
    const behavior2 = (label) => {
      if (label === "需求整理") return NORMALIZED
      if (label.startsWith("探索：")) return EXPLORE
      if (label === "任务规划")
        return {
          strategy: "s",
          tasks: [
            {
              id: "task-v",
              title: "任务V",
              objective: "v",
              why: "w",
              targetFiles: [],
              acceptanceCriteria: ["v ok"],
              validationCommands: [],
              dependencies: [],
              riskLevel: "low"
            }
          ],
          globalValidationCommands: [],
          blockers: [],
          canImplement: true
        }
      if (label.startsWith("实现：")) return IMPL_OK
      if (label.startsWith("验证：")) return VERIFY_PASS
      if (label === "总体验收")
        return {
          verdict: "ready",
          summary: "误报",
          acceptanceCoverage: [
            { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
          ],
          commandChecks: [{ command: "额外检查", result: "fail", evidence: "退出码1" }],
          releaseNotes: [],
          remainingIssues: [],
          nextActions: []
        }
      throw new Error("未知 agent label: " + label)
    }
    const logs2 = []
    const env2 = makeEnv({ files: {}, agentBehavior: behavior2, logs: logs2 })
    const r2 = await runScript(
      env2.agent,
      env2.parallel,
      env2.phase,
      env2.log,
      "额外失败命令测试需求",
      env2.glob,
      env2.readFile,
      env2.writeFile
    )
    console.log("清单外失败命令也降级:", r2.状态 === "需要修复" ? "PASS" : "FAIL " + r2.状态)
    console.log(
      "额外失败命令被点名:",
      logs2.some((l) => l.includes("额外报告了失败命令") && l.includes("额外检查"))
        ? "PASS"
        : "FAIL"
    )
  }
}

// ===== 场景12:maxTasks 是执行预算——超出任务留待续跑,绝不静默丢弃报可交付 =====
async function scenario12() {
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          // B 用"标题"引用依赖 A(真实规划代理的常见写法),验证标题映射
          {
            id: "Task B",
            title: "任务B",
            objective: "b",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["b ok"],
            validationCommands: [],
            dependencies: ["任务A"],
            riskLevel: "low"
          },
          {
            id: "Task A",
            title: "任务A",
            objective: "a",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["a ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          },
          {
            id: "Task C",
            title: "任务C",
            objective: "c",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["c ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "ok",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        commandChecks: [],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: behavior, logs: logs1 })
  const r1 = await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    { requirement: "执行预算测试需求", maxTasks: 2 },
    env1.glob,
    env1.readFile,
    env1.writeFile
  )
  console.log("\n== 场景12 执行预算分批 ==")
  console.log(
    "标题依赖被正确映射(无断链告警):",
    logs1.every((l) => !l.includes("无法解析的任务依赖")) ? "PASS" : "FAIL"
  )
  const idxA = logs1.findIndex((l) => l === "AGENT: 实现：任务A")
  const idxB = logs1.findIndex((l) => l === "AGENT: 实现：任务B")
  console.log("拓扑序 A 先于 B:", idxA >= 0 && idxB > idxA ? "PASS" : "FAIL")
  console.log(
    "预算用尽有日志且点名剩余任务:",
    logs1.some((l) => l.includes("任务预算已用尽") && l.includes("task-c")) ? "PASS" : "FAIL"
  )
  console.log(
    "首跑如实 needs_fix(不虚报可交付):",
    r1.状态 === "需要修复" && (r1.剩余问题 || []).some((x) => x.includes("task-c"))
      ? "PASS"
      : "FAIL " + r1.状态
  )
  // 续跑第二批:完成 task-c 后才可交付
  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "执行预算测试需求", maxTasks: 2 },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  console.log(
    "续跑完成剩余批次后可交付:",
    r2.状态 === "可交付" && logs2.filter((l) => l.includes("跳过已完成任务")).length === 2
      ? "PASS"
      : "FAIL " + r2.状态
  )
}

// ===== 场景13:replan 后同 ID 任务契约变化 → 旧完成状态失效,强制重跑 =====
async function scenario13() {
  const files = {}
  let planCalls = 0
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划") {
      planCalls += 1
      const criteria = planCalls === 1 ? ["a ok"] : ["a ok 加强版"] // 同 ID,契约变化
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-a",
            title: "任务A",
            objective: "a",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: criteria,
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    }
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "ok",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        commandChecks: [],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: behavior, logs: logs1 })
  await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    "契约指纹测试需求",
    env1.glob,
    env1.readFile,
    env1.writeFile
  )

  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "契约指纹测试需求", replan: true },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  const calls2 = logs2.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  console.log("\n== 场景13 契约变化强制重跑 ==")
  console.log(
    "契约变化被识别并告警:",
    logs2.some((l) => l.includes("契约已变化")) ? "PASS" : "FAIL"
  )
  console.log(
    "同 ID 任务被重新执行:",
    calls2.includes("实现：任务A") ? "PASS" : "FAIL " + JSON.stringify(calls2)
  )
  console.log("重跑后仍可交付:", r2.状态 === "可交付" ? "PASS" : "FAIL " + r2.状态)
}

// ===== 场景14:需求验收标准未被覆盖(规划遗漏)→ 最终门禁降级 =====
async function scenario14() {
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-m",
            title: "任务M",
            objective: "m",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["m ok"],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：")) return IMPL_OK
    if (label.startsWith("验证：")) return VERIFY_PASS
    if (label === "总体验收")
      // 误报 ready 且验收覆盖为空——需求 AC-1 没有任何 covered 证据
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [],
        commandChecks: [],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "覆盖缺失测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景14 需求覆盖缺失降级 ==")
  console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "缺失的需求 AC 被点名:",
    logs.some((l) => l.includes("需求验收标准未覆盖") && l.includes("AC-1")) ? "PASS" : "FAIL"
  )
}

// ===== 场景15:任务声明的验证命令未被报告 → 一致性门禁降级 =====
async function scenario15() {
  const files = {}
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "任务规划")
      return {
        strategy: "s",
        tasks: [
          {
            id: "task-n",
            title: "任务N",
            objective: "n",
            why: "w",
            targetFiles: [],
            acceptanceCriteria: ["n ok"],
            validationCommands: ["npm test"],
            dependencies: [],
            riskLevel: "low"
          }
        ],
        globalValidationCommands: [],
        blockers: [],
        canImplement: true
      }
    if (label.startsWith("实现：") || label.startsWith("修复：")) return IMPL_OK
    if (label.startsWith("验证：") || label.startsWith("复验：")) return VERIFY_PASS // 未报告声明命令
    if (label === "总体验收")
      return {
        verdict: "ready",
        summary: "误报",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "覆盖" }
        ],
        commandChecks: [],
        releaseNotes: [],
        remainingIssues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const logs = []
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "声明命令未报告测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  const state = JSON.parse(
    files[".cmbdevclaw/长程自动开发工作流/声明命令未报告测试需求/状态.json"] || "null"
  )
  const taskIssues = JSON.stringify((state && state.tasks) || [])
  console.log("\n== 场景15 声明命令未报告降级 ==")
  console.log("任务未被标 ready:", r.已完成任务数 === 0 ? "PASS" : "FAIL")
  console.log(
    "声明命令缺失理由入账:",
    taskIssues.includes("声明的验证命令未执行或未通过") ? "PASS" : "FAIL"
  )
  console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
}

;(async () => {
  await scenario1and2()
  await scenario3()
  await scenario4()
  await scenario5()
  await scenario6()
  await scenario7()
  await scenario8()
  await scenario9()
  await scenario10()
  await scenario11()
  await scenario12()
  await scenario13()
  await scenario14()
  await scenario15()
})()
  .catch((e) => {
    console.error("DRYRUN ERROR:", e)
    process.exitCode = 1
  })
  .finally(() => {
    if (dryrunFailures > 0) {
      rawLog(`\n${dryrunFailures} 个断言 FAIL`)
      process.exitCode = 1
    } else {
      rawLog("\n全部断言 PASS")
    }
  })
