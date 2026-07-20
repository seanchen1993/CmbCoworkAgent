/**
 * Behavioral dry-run suite for docs/workflows/auto-dev-from-requirement.workflow.js —
 * mocks the workflow sandbox globals and runs the REAL script end-to-end.
 * Focus: the final hard gate (ready requires verification pass + full acceptance
 * coverage, not just the review agent's verdict). Assertions print PASS/FAIL
 * lines; any FAIL makes the process exit non-zero so CI hard-fails.
 *
 * Run:
 *   npx tsx tests/auto-dev-requirement-dryrun.spec.mjs
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
  path.join(__dirname, "..", "docs", "workflows", "auto-dev-from-requirement.workflow.js"),
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
  return {
    agent: async (prompt, opts) => {
      const label = (opts && opts.label) || ""
      logs.push("AGENT: " + label)
      return agentBehavior(label, prompt)
    },
    parallel: (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    phase: (t) => logs.push("PHASE: " + t),
    log: (m) => logs.push("LOG: " + m),
    glob: async () => [],
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT: " + p)
      return files[p]
    },
    writeFile: async (p, c) => {
      files[p] = c
    }
  }
}

const NORMALIZED = {
  title: "轻量测试需求",
  problem: "p",
  goal: "g",
  scope: ["s"],
  acceptanceCriteria: ["验收1"],
  constraints: [],
  unknowns: [],
  canProceed: true,
  proceedReason: "信息充分"
}
const EXPLORE = {
  architectureSummary: "小项目",
  relevantFiles: [],
  risks: [],
  suggestedTestCommands: ["npm test"],
  confidence: "high"
}
const PLAN = {
  approach: "直接实现",
  steps: ["改代码"],
  targetFiles: [],
  testCommands: ["npm test"],
  needsHumanDecision: false,
  blockers: [],
  rollbackPlan: "git revert"
}
const IMPL_OK = {
  status: "changed",
  summary: "已实现",
  changedFiles: ["src/a.ts"],
  testsRun: ["npm test"],
  blockers: [],
  followUps: []
}
const VERIFY_PASS = {
  status: "pass",
  summary: "通过",
  commands: [{ command: "npm test", result: "pass", evidence: "ok" }],
  issues: [],
  recommendedFixes: []
}
const REVIEW_READY = () => ({
  verdict: "ready",
  summary: "全部满足",
  acceptanceCoverage: [{ id: "AC-1", criterion: "验收1", status: "covered", evidence: "测试通过" }],
  issues: [],
  nextActions: []
})

// ===== 场景1:复核误报 ready 但验证未通过 → 硬门禁降级 =====
async function scenario1() {
  const files = {}
  const logs = []
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "实现计划") return PLAN
    if (label === "代码实现") return IMPL_OK
    if (label === "验证实现")
      return { ...VERIFY_PASS, status: "fail", summary: "断言失败", issues: ["边界错误"] }
    if (label === "修复验证问题")
      return { ...IMPL_OK, status: "blocked", blockers: ["无法安全修复"] }
    if (label === "最终验收复核") return REVIEW_READY() // 故意误报 ready
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "轻量硬门禁测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("== 场景1 误报 ready 被硬门禁降级 ==")
  console.log("最终状态为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log("降级有日志:", logs.some((l) => l.includes("硬门禁降级")) ? "PASS" : "FAIL")
  console.log(
    "降级理由入最终问题:",
    (r.最终问题 || []).some((s) => s.includes("硬门禁降级")) ? "PASS" : "FAIL"
  )
  const report = files[Object.keys(files).find((k) => k.endsWith("交付报告.md"))] || ""
  console.log("报告结论同步为需要修复:", report.includes("【硬门禁降级】") ? "PASS" : "FAIL")
  // 产物一致性:单独的验证报告.md 也必须是降级后的口径,不能残留 ready
  const verifyDoc = files[Object.keys(files).find((k) => k.endsWith("验证报告.md"))] || ""
  console.log(
    "验证报告同步为降级口径:",
    verifyDoc.includes("【硬门禁降级】") && verifyDoc.includes("需要修复") ? "PASS" : "FAIL"
  )
  console.log(
    "验证报告不残留可交付结论:",
    !verifyDoc.includes("**结论：** 可交付") ? "PASS" : "FAIL"
  )
}

// ===== 场景2:验证通过 + 覆盖全 covered + 复核 ready → 正常放行 =====
async function scenario2() {
  const files = {}
  const logs = []
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "实现计划") return PLAN
    if (label === "代码实现") return IMPL_OK
    if (label === "验证实现") return VERIFY_PASS
    if (label === "最终验收复核") return REVIEW_READY()
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "轻量放行测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景2 全绿正常放行 ==")
  console.log("最终状态为可交付:", r.状态 === "可交付" ? "PASS" : "FAIL " + r.状态)
  console.log("无降级日志:", logs.every((l) => !l.includes("硬门禁降级")) ? "PASS" : "FAIL")
}

// ===== 场景3:需求 2 条验收标准,复核只覆盖 1 条 → 必须降级(不得部分覆盖放行) =====
async function scenario3() {
  const files = {}
  const logs = []
  const NORMALIZED2 = { ...NORMALIZED, title: "双标准需求", acceptanceCriteria: ["验收1", "验收2"] }
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED2
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "实现计划") return PLAN
    if (label === "代码实现") return IMPL_OK
    if (label === "验证实现") return VERIFY_PASS
    if (label === "最终验收复核")
      return {
        verdict: "ready",
        summary: "看起来都好",
        acceptanceCoverage: [
          { id: "AC-1", criterion: "验收1", status: "covered", evidence: "测试通过" } // 漏掉 AC-2
        ],
        issues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "部分覆盖测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景3 部分覆盖必须降级 ==")
  console.log("最终状态为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "降级理由点名缺失的 AC:",
    logs.some((l) => l.includes("硬门禁降级") && l.includes("未覆盖:AC-2")) ? "PASS" : "FAIL"
  )
  const report = files[Object.keys(files).find((k) => k.endsWith("交付报告.md"))] || ""
  console.log("报告含降级标记:", report.includes("【硬门禁降级】") ? "PASS" : "FAIL")
}

// ===== 场景4(检视方反例):无关 covered 项凑数 → ID 集合对齐必须降级 =====
async function scenario4() {
  const files = {}
  const logs = []
  const NORMALIZED2 = {
    ...NORMALIZED,
    title: "无关凑数需求",
    acceptanceCriteria: ["必须记录登录 IP", "必须记录登出 IP"]
  }
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED2
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "实现计划") return PLAN
    if (label === "代码实现") return IMPL_OK
    if (label === "验证实现") return VERIFY_PASS
    if (label === "最终验收复核")
      return {
        verdict: "ready",
        summary: "看起来都好",
        // 数量够、全 covered、证据非空——但 AC-2 没被覆盖,第二条是清单外的无关项
        acceptanceCoverage: [
          { id: "AC-1", criterion: "必须记录登录 IP", status: "covered", evidence: "日志已验证" },
          { id: "AC-99", criterion: "新增了日志表", status: "covered", evidence: "表已建" }
        ],
        issues: [],
        nextActions: []
      }
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "无关凑数测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景4 无关项凑数必须降级 ==")
  console.log("最终状态为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "降级理由点名 AC-2 未覆盖:",
    logs.some((l) => l.includes("硬门禁降级") && l.includes("未覆盖:AC-2")) ? "PASS" : "FAIL"
  )
}

// ===== 场景5(检视方复现):计划声明了测试命令,验证却零报告 → 必须降级 =====
async function scenario5() {
  const files = {}
  const logs = []
  const behavior = (label) => {
    if (label === "需求整理") return NORMALIZED
    if (label.startsWith("探索：")) return EXPLORE
    if (label === "实现计划") return PLAN // testCommands: ["npm test"]
    if (label === "代码实现") return IMPL_OK
    if (label === "验证实现") return { ...VERIFY_PASS, commands: [] } // 声明命令零报告
    if (label === "最终验收复核") return REVIEW_READY()
    throw new Error("未知 agent label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "命令零报告测试需求",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景5 计划命令零报告降级 ==")
  console.log("最终状态为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
  console.log(
    "降级理由点名计划命令:",
    logs.some((l) => l.includes("硬门禁降级") && l.includes("npm test")) ? "PASS" : "FAIL"
  )
}

;(async () => {
  await scenario1()
  await scenario2()
  await scenario3()
  await scenario4()
  await scenario5()
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
