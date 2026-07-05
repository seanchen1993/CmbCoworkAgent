/**
 * Behavioral dry-run suite for docs/workflows/contract-delivery.workflow.js — mocks the workflow
 * sandbox globals (agent/parallel/phase/log/glob/readFile/writeFile) and runs
 * the REAL script end-to-end across scenarios (resume, gating, hard gates,
 * cascade invalidation...). Assertions print PASS/FAIL lines; any FAIL makes
 * the process exit non-zero so CI hard-fails.
 *
 * Run:
 *   npx tsx tests/contract-delivery-dryrun.spec.mjs
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
  path.join(__dirname, "..", "docs", "workflows", "contract-delivery.workflow.js"),
  "utf8"
)
src = src.replace(/^export const meta/m, "const meta")

// 防漂移守卫:技能捆绑的脚本副本必须与正本逐字一致(技能随目录分发,漂移即发错版)
{
  const bundled = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "docs",
      "workflows",
      "contract-delivery",
      "workflow",
      "contract-delivery.workflow.js"
    ),
    "utf8"
  )
  const canonical = fs.readFileSync(
    path.join(__dirname, "..", "docs", "workflows", "contract-delivery.workflow.js"),
    "utf8"
  )
  console.log(
    "技能捆绑副本与正本一致:",
    bundled === canonical
      ? "PASS"
      : "FAIL 请执行 cp docs/workflows/contract-delivery.workflow.js docs/workflows/contract-delivery/workflow/"
  )
}

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

const EXPLORE = {
  summary: "spring boot 项目",
  relevantFiles: [],
  testCommands: ["mvn test"],
  buildCommands: [],
  risks: []
}
const IMPL_OK = {
  status: "changed",
  summary: "已实现",
  changedFiles: ["src/A.java"],
  commandsRun: ["mvn test"],
  blockers: [],
  notes: []
}

function contractOf(n, cmds, complexity) {
  return {
    title: "测试合同",
    problem: "p",
    goal: "g",
    complexity: complexity || "standard",
    nonGoals: [],
    constraints: [],
    conventions: ["统一审计入口"],
    criteria: Array.from({ length: n }, (_, i) => ({
      id: `AC-${i + 1}`,
      text: `标准${i + 1}`,
      verify: "code",
      hint: ""
    })),
    globalValidationCommands: cmds,
    openQuestions: [],
    canProceed: true,
    proceedReason: "ok"
  }
}

function acIdsFromPrompt(prompt) {
  const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0])
}

function pendingFromPlanPrompt(prompt) {
  const after = prompt.split("待证实标准（含上一轮")[1] || ""
  const ids = [...after.matchAll(/"id":\s*"(AC-\d+)"/g)].map((m) => m[1])
  return [...new Set(ids)]
}

function planFor(pending) {
  const packages = []
  for (let i = 0; i < pending.length; i += 2) {
    const acIds = pending.slice(i, i + 2)
    packages.push({
      id: `pkg-${i / 2 + 1}`,
      title: `包${i / 2 + 1}`,
      objective: "o",
      acIds,
      targetFiles: [],
      validationCommands: [],
      dependencies: i >= 2 ? [`pkg-${i / 2}`] : [],
      riskLevel: "low"
    })
  }
  return { strategy: "s", conventionsBrief: "公约v1", packages, canImplement: true, blockers: [] }
}

// ===== 场景1：4条标准，漏核判罚→修复，对抗驳回→第2轮补救，终审通过 =====
async function scenario1() {
  const files = {}
  const logs = []
  let omittedOnce = false
  let auditCalls = 0
  const behavior = (label, prompt) => {
    if (label === "需求成契") return contractOf(4, ["mvn test"])
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
    if (label.startsWith("实现R") || label.startsWith("修复R")) return IMPL_OK
    if (label.startsWith("验证R") || label.startsWith("复验R")) {
      const acIds = acIdsFromPrompt(prompt)
      let per = acIds.map((id) => ({ id, result: "pass", evidence: `代码 ${id}.java:10` }))
      if (label.startsWith("验证R") && acIds.includes("AC-2") && !omittedOnce) {
        omittedOnce = true
        per = per.filter((p) => p.id !== "AC-2") // 故意漏核 AC-2
      }
      return {
        status: "pass",
        summary: "ok",
        perAc: per,
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) {
      auditCalls += 1
      if (auditCalls === 1)
        return { summary: "驳回一条", refutations: [{ id: "AC-3", reason: "证据行号对不上" }] }
      return { summary: "无可驳回", refutations: [] }
    }
    if (label === "终审命令核对")
      return {
        summary: "ok",
        commands: [{ command: "mvn test", passed: true, evidence: "BUILD SUCCESS" }]
      }
    throw new Error("未知 label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "契约测试需求甲",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("== 场景1 多轮收敛 ==")
  console.log("状态:", r.状态, "| 轮次:", r.轮次, "| 已证实:", r.已证实 + "/" + r.验收标准总数)
  console.log("漏核判罚触发修复:", logs.some((l) => l.includes("AGENT: 修复R1")) ? "PASS" : "FAIL")
  console.log("对抗驳回记录:", logs.some((l) => l.includes("对抗复核驳回 AC-3")) ? "PASS" : "FAIL")
  console.log(
    "第2轮只补驳回项:",
    logs.some((l) => l === "AGENT: 第2轮规划") && r.轮次 === 2 ? "PASS" : "FAIL"
  )
  console.log("最终 ready:", r.状态 === "可交付" ? "PASS" : "FAIL " + r.说明)
  return { files, behavior }
}

// ===== 场景2：续跑（全复用直达终审）+ forceAcIds 精确重打 =====
async function scenario2(prev) {
  const logs = []
  const env = makeEnv({ files: prev.files, agentBehavior: prev.behavior, logs })
  await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "契约测试需求甲",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景2 续跑 ==")
  console.log("复用合同与账本:", logs.some((l) => l.includes("复用已有交付合同")) ? "PASS" : "FAIL")
  console.log("复用项目画像:", logs.some((l) => l.includes("复用已有项目画像")) ? "PASS" : "FAIL")
  const calls = logs.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  console.log(
    "跳过交付循环直达终审:",
    JSON.stringify(calls) === JSON.stringify(["终审命令核对"])
      ? "PASS"
      : "FAIL " + JSON.stringify(calls)
  )

  const logs2 = []
  const env2 = makeEnv({ files: prev.files, agentBehavior: prev.behavior, logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "契约测试需求甲", forceAcIds: ["AC-1"] },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  const calls2 = logs2.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  // 轮次跨续跑连续计数:场景1用了2轮,此处续跑应从第3轮接着编号(不覆盖历史轮次产物)
  const replanned = calls2.includes("第3轮规划") && calls2.some((c) => c.startsWith("实现R3"))
  console.log(
    "forceAcIds 重置并重打 AC-1(轮次续编):",
    logs2.some((l) => l.includes("已重置标准 AC-1")) && replanned
      ? "PASS"
      : "FAIL " + JSON.stringify(calls2)
  )
  console.log("重打后仍 ready:", r2.状态 === "可交付" ? "PASS" : "FAIL")
}

// ===== 场景3：规划漏认领 → 告警且如实 needs_fix =====
async function scenario3() {
  const files = {}
  const logs = []
  const behavior = (label, prompt) => {
    if (label === "需求成契") return contractOf(2, [], "standard")
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label))
      return {
        strategy: "s",
        conventionsBrief: "公约",
        canImplement: true,
        blockers: [],
        packages: [
          {
            id: "pkg-1",
            title: "包1",
            objective: "o",
            acIds: ["AC-1"],
            targetFiles: [],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ]
      }
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const acIds = acIdsFromPrompt(prompt)
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    throw new Error("未知 label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "契约测试需求乙",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景3 漏认领 ==")
  console.log(
    "未认领告警:",
    logs.some((l) => l.includes("未被任何工作包认领：AC-2")) ? "PASS" : "FAIL"
  )
  console.log(
    "如实 needs_fix 且列出 AC-2:",
    r.状态 === "需要修复" && r.未证实.some((s) => s.startsWith("AC-2")) ? "PASS" : "FAIL " + r.状态
  )
}

// ===== 场景4：外部合同注入 + 终审漏执行命令按失败计 =====
async function scenario4() {
  const files = {}
  const logs = []
  const behavior = (label, prompt) => {
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const acIds = acIdsFromPrompt(prompt)
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [
          { command: "mvn test", result: "pass", evidence: "ok" },
          { command: "npm run lint", result: "pass", evidence: "ok" }
        ],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    if (label === "终审命令核对")
      return {
        summary: "只跑了一条",
        commands: [{ command: "mvn test", passed: true, evidence: "ok" }]
      }
    if (label === "需求成契") throw new Error("外部合同注入时不应调用成契 agent")
    throw new Error("未知 label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const contract = {
    ...contractOf(1, ["mvn test", "npm run lint"]),
    // 半结构化输入:字符串而非数组——脚本必须宽容归一化而不是渲染时崩溃
    nonGoals: "不改动UI",
    conventions: "沿用现有风格"
  }
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    { requirement: "契约测试需求丙", contract },
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景4 外部合同 + 终审交叉核对 ==")
  console.log(
    "外部合同生效(未调成契):",
    logs.some((l) => l.includes("使用外部注入合同")) ? "PASS" : "FAIL"
  )
  console.log(
    "漏执行命令按失败计:",
    r.终审.some((s) => s.includes("npm run lint → 失败"))
      ? "PASS"
      : "FAIL " + JSON.stringify(r.终审)
  )
  console.log("虽全证实仍 needs_fix:", r.状态 === "需要修复" && r.已证实 === 1 ? "PASS" : "FAIL")
}

// ===== 场景5：验证始终失败 → 空转守卫，1 轮即停 =====
async function scenario5() {
  const files = {}
  const logs = []
  const behavior = (label, prompt) => {
    if (label === "需求成契") return contractOf(2, [], "standard")
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
    if (label.startsWith("实现R") || label.startsWith("修复R")) return IMPL_OK
    if (label.startsWith("验证R") || label.startsWith("复验R")) {
      const acIds = acIdsFromPrompt(prompt)
      return {
        status: "fail",
        summary: "都不行",
        perAc: acIds.map((id) => ({ id, result: "fail", evidence: "断言失败" })),
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    throw new Error("未知 label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "契约测试需求丁",
    env.glob,
    env.readFile,
    env.writeFile
  )
  console.log("\n== 场景5 空转守卫 ==")
  console.log(
    "1轮即停(未跑满3轮):",
    r.轮次 === 1 && logs.some((l) => l.includes("停止循环以避免空转"))
      ? "PASS"
      : "FAIL 轮次=" + r.轮次
  )
  console.log("如实 needs_fix:", r.状态 === "需要修复" && r.未证实.length === 2 ? "PASS" : "FAIL")
}

// ===== 场景6：simple 档直通 —— 跳过规划代理、单视角探索，质量三件套保留 =====
async function scenario6() {
  const files = {}
  const logs = []
  const behavior = (label, prompt) => {
    if (label === "需求成契") return contractOf(2, ["mvn test"], "simple")
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) throw new Error("simple 档不应调用规划代理")
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const acIds = acIdsFromPrompt(prompt)
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [{ command: "mvn test", result: "pass", evidence: "ok" }],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    if (label === "终审命令核对")
      return {
        summary: "ok",
        commands: [{ command: "mvn test", passed: true, evidence: "BUILD SUCCESS" }]
      }
    throw new Error("未知 label: " + label)
  }
  const env = makeEnv({ files, agentBehavior: behavior, logs })
  const r = await runScript(
    env.agent,
    env.parallel,
    env.phase,
    env.log,
    "契约测试需求戊",
    env.glob,
    env.readFile,
    env.writeFile
  )
  const calls = logs.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
  const exploreCalls = calls.filter((c) => c.startsWith("探索：")).length
  console.log("\n== 场景6 simple 档直通 ==")
  console.log(
    "档位判定为 simple:",
    logs.some((l) => l.includes("复杂度档位：simple")) ? "PASS" : "FAIL"
  )
  console.log("跳过规划代理:", !calls.some((c) => /^第\d+轮规划$/.test(c)) ? "PASS" : "FAIL")
  console.log("单视角探索:", exploreCalls === 1 ? "PASS" : "FAIL " + exploreCalls)
  console.log(
    "对抗复核与终审保留:",
    calls.includes("对抗复核R1") && calls.includes("终审命令核对") ? "PASS" : "FAIL"
  )
  console.log(
    "总代理调用数(应为6):",
    calls.length === 6 ? "PASS" : "FAIL " + calls.length + " " + JSON.stringify(calls)
  )
  console.log("最终 ready:", r.状态 === "可交付" ? "PASS" : "FAIL " + r.说明)
}

// ===== 场景7:空外部合同被拒 + 零变更文件时终审仍执行 =====
async function scenario7() {
  console.log("\n== 场景7 空合同防线 + 终审不可跳过 ==")
  // 7a: 外部合同只有空文本标准 → 必须抛错拒绝
  {
    const env = makeEnv({
      files: {},
      agentBehavior: () => {
        throw new Error("不应调用任何 agent")
      },
      logs: []
    })
    let rejected = false
    try {
      await runScript(
        env.agent,
        env.parallel,
        env.phase,
        env.log,
        {
          requirement: "空合同测试",
          contract: { title: "t", criteria: [{ id: "AC-1", text: "  ", verify: "code", hint: "" }] }
        },
        env.glob,
        env.readFile,
        env.writeFile
      )
    } catch (e) {
      rejected = String(e.message || e).includes("至少一条有效验收标准")
    }
    console.log("空合同被硬性拒绝:", rejected ? "PASS" : "FAIL")
  }
  // 7c: agent 生成合同全是空白文本标准(穿过 schema minLength) → 同样硬性失败
  {
    const behavior = (label) => {
      if (label === "需求成契") {
        const c = contractOf(2, [], "standard")
        c.criteria = c.criteria.map((x) => ({ ...x, text: "   " }))
        return c
      }
      throw new Error("不应到达: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs: [] })
    let rejected = false
    try {
      await runScript(
        env.agent,
        env.parallel,
        env.phase,
        env.log,
        "空白合同测试",
        env.glob,
        env.readFile,
        env.writeFile
      )
    } catch (e) {
      rejected = String(e.message || e).includes("没有任何有效验收标准")
    }
    console.log("生成路径空白合同被硬性拒绝:", rejected ? "PASS" : "FAIL")
  }
  // 7b: 实现返回 no_change_needed(changedFiles 为空),合同有全局命令 → 终审必须执行
  {
    const logs = []
    const behavior = (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (label.startsWith("实现R"))
        return {
          status: "no_change_needed",
          summary: "已满足",
          changedFiles: [],
          commandsRun: [],
          blockers: [],
          notes: []
        }
      if (label.startsWith("验证R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [{ command: "mvn test", result: "pass", evidence: "ok" }],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      if (label === "终审命令核对")
        return { summary: "ok", commands: [{ command: "mvn test", passed: true, evidence: "ok" }] }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      { requirement: "零变更终审测试", contract: contractOf(1, ["mvn test"], "simple") },
      env.glob,
      env.readFile,
      env.writeFile
    )
    const ranRunner = logs.some((l) => l === "AGENT: 终审命令核对")
    console.log("零变更文件仍执行终审:", ranRunner ? "PASS" : "FAIL")
    console.log(
      "终审通过后 ready:",
      r.状态 === "可交付" && r.终审.some((s) => s.includes("通过")) ? "PASS" : "FAIL " + r.状态
    )
  }
}

// ===== 场景8:空合同包被丢弃 + 包级矛盾(命令失败但明细全 pass)不予采信 =====
async function scenario8() {
  console.log("\n== 场景8 空合同包丢弃 + 包级矛盾不予采信 ==")
  // 8a: 规划返回一个全无效 acIds 的包 → 丢弃并告警,不执行
  {
    const logs = []
    const behavior = (label, prompt) => {
      if (label === "需求成契") return contractOf(1, [], "standard")
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label))
        return {
          strategy: "s",
          conventionsBrief: "公约",
          canImplement: true,
          blockers: [],
          packages: [
            {
              id: "ghost-pkg",
              title: "幽灵包",
              objective: "o",
              acIds: ["AC-99"],
              targetFiles: [],
              validationCommands: [],
              dependencies: [],
              riskLevel: "low"
            },
            {
              id: "real-pkg",
              title: "真实包",
              objective: "o",
              acIds: ["AC-1"],
              targetFiles: [],
              validationCommands: [],
              dependencies: [],
              riskLevel: "low"
            }
          ]
        }
      if (label.startsWith("实现R")) {
        if (prompt.includes("幽灵包")) throw new Error("幽灵包不应被执行")
        return IMPL_OK
      }
      if (label.startsWith("验证R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      "空包丢弃测试需求",
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log(
      "空合同包被丢弃并告警:",
      logs.some((l) => l.includes("没有任何有效验收标准") && l.includes("ghost-pkg"))
        ? "PASS"
        : "FAIL"
    )
    console.log("有效包正常交付:", r.状态 === "可交付" ? "PASS" : "FAIL " + r.状态)
  }
  // 8b: perAc 全 pass 但命令检查有 fail → 通过结论不予采信 → 不得证实
  {
    const logs = []
    const contradictoryVerify = (acIds) => ({
      status: "pass",
      summary: "看着行",
      perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
      commandChecks: [{ command: "mvn test", result: "fail", evidence: "编译错误" }],
      issues: [],
      recommendedFixes: []
    })
    const behavior = (label, prompt) => {
      if (label === "需求成契") return contractOf(1, [], "standard")
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
      if (label.startsWith("实现R") || label.startsWith("修复R")) return IMPL_OK
      if (label.startsWith("验证R") || label.startsWith("复验R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return contradictoryVerify(acIds)
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      "包级矛盾测试需求",
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log("矛盾包不得证实任何标准:", r.已证实 === 0 ? "PASS" : "FAIL " + r.已证实)
    console.log("整体为需要修复:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
    console.log(
      "不予采信理由入账:",
      (r.未证实 || []).some((s) => s.includes("包级验证不一致"))
        ? "PASS"
        : "FAIL " + JSON.stringify(r.未证实)
    )
  }
}

// ===== 场景9:显式合同覆盖旧状态 + 终审额外失败命令不可丢弃 =====
async function scenario9() {
  console.log("\n== 场景9 显式合同覆盖 + 额外失败命令 ==")
  // 9a: 已交付状态存在时再显式注入新合同 → 必须按新合同重建账本并重新执行
  {
    const files = {}
    const mkBehavior = () => (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
      if (label.startsWith("实现R")) return IMPL_OK
      if (label.startsWith("验证R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      if (label === "需求成契") throw new Error("显式合同注入不应调用成契")
      throw new Error("未知 label: " + label)
    }
    const logsA = []
    const envA = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsA })
    const rA = await runScript(
      envA.agent,
      envA.parallel,
      envA.phase,
      envA.log,
      { requirement: "合同覆盖测试需求", contract: contractOf(1, [], "standard") },
      envA.glob,
      envA.readFile,
      envA.writeFile
    )
    const logsB = []
    const envB = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsB })
    const rB = await runScript(
      envB.agent,
      envB.parallel,
      envB.phase,
      envB.log,
      { requirement: "合同覆盖测试需求", contract: contractOf(2, [], "standard") },
      envB.glob,
      envB.readFile,
      envB.writeFile
    )
    console.log("首跑按合同A交付:", rA.状态 === "可交付" && rA.验收标准总数 === 1 ? "PASS" : "FAIL")
    console.log(
      "新合同覆盖旧状态并告警:",
      logsB.some((l) => l.includes("账本按新合同重建")) ? "PASS" : "FAIL"
    )
    console.log(
      "账本按新合同重建并重新执行:",
      rB.验收标准总数 === 2 &&
        logsB.some((l) => l.startsWith("AGENT: 实现R")) &&
        rB.状态 === "可交付"
        ? "PASS"
        : "FAIL " + rB.验收标准总数 + "/" + rB.状态
    )
    console.log(
      "新合同不复用旧项目画像且轮次重置:",
      logsB.some((l) => l.startsWith("AGENT: 探索：")) && rB.轮次 === 1
        ? "PASS"
        : "FAIL " + JSON.stringify(logsB.filter((l) => l.startsWith("AGENT"))) + "/round=" + rB.轮次
    )
  }
  // 9b: 终审如实报告清单外失败命令 → 不得丢弃,必须降级
  {
    const files = {}
    const logs = []
    const behavior = (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label)) return planFor(pendingFromPlanPrompt(prompt))
      if (label.startsWith("实现R")) return IMPL_OK
      if (label.startsWith("验证R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      if (label === "终审命令核对")
        return {
          summary: "跑了合同命令,顺手发现另一个失败",
          commands: [
            { command: "mvn test", passed: true, evidence: "ok" },
            { command: "npm lint", passed: false, evidence: "退出码1" }
          ]
        }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      { requirement: "额外失败终审测试需求", contract: contractOf(1, ["mvn test"], "standard") },
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log("额外失败命令导致 needs_fix:", r.状态 === "需要修复" ? "PASS" : "FAIL " + r.状态)
    console.log(
      "额外失败命令进入终审清单:",
      (r.终审 || []).some((s2) => s2.includes("npm lint") && s2.includes("失败"))
        ? "PASS"
        : "FAIL " + JSON.stringify(r.终审)
    )
  }
}

// ===== 场景10:非法 contract 形状硬拒 + 包声明命令未报告不予采信 =====
async function scenario10() {
  console.log("\n== 场景10 非法合同形状 + 声明命令未报告 ==")
  // 10a: contract 传了但 criteria 不是数组 → 必须抛错,不得静默复用旧合同
  {
    const env = makeEnv({
      files: {},
      agentBehavior: () => {
        throw new Error("不应调用 agent")
      },
      logs: []
    })
    let rejected = false
    try {
      await runScript(
        env.agent,
        env.parallel,
        env.phase,
        env.log,
        { requirement: "非法合同测试", contract: { title: "t", criteria: "oops" } },
        env.glob,
        env.readFile,
        env.writeFile
      )
    } catch (e) {
      rejected = String(e.message || e).includes("形状不合法")
    }
    console.log("非法形状被硬拒:", rejected ? "PASS" : "FAIL")
  }
  // 10b: 工作包声明了验证命令但验证未报告 → 通过明细不予采信
  {
    const logs = []
    const behavior = (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label))
        return {
          strategy: "s",
          conventionsBrief: "公约",
          canImplement: true,
          blockers: [],
          packages: [
            {
              id: "pkg-1",
              title: "包1",
              objective: "o",
              acIds: ["AC-1"],
              targetFiles: [],
              validationCommands: ["mvn test"],
              dependencies: [],
              riskLevel: "low"
            }
          ]
        }
      if (label.startsWith("实现R") || label.startsWith("修复R")) return IMPL_OK
      if (label.startsWith("验证R") || label.startsWith("复验R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      { requirement: "声明命令未报告契约测试", contract: contractOf(1, [], "standard") },
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log("声明命令未报告不得证实:", r.已证实 === 0 ? "PASS" : "FAIL " + r.已证实)
    console.log(
      "不予采信理由含声明命令:",
      (r.未证实 || []).some((x) => x.includes("声明的验证命令未执行或未通过")) ? "PASS" : "FAIL"
    )
  }
  // 10c: 修复路径正向恢复——首验漏报声明命令被降级,复验合规回报后必须放行,
  // 不得因 prompt/门禁脱节耗尽修复轮次误卡 needs_fix
  {
    const logs = []
    const behavior = (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (/^第\d+轮规划$/.test(label))
        return {
          strategy: "s",
          conventionsBrief: "公约",
          canImplement: true,
          blockers: [],
          packages: [
            {
              id: "pkg-1",
              title: "包1",
              objective: "o",
              acIds: ["AC-1"],
              targetFiles: [],
              validationCommands: ["mvn test"],
              dependencies: [],
              riskLevel: "low"
            }
          ]
        }
      if (label.startsWith("实现R") || label.startsWith("修复R")) return IMPL_OK
      if (label.startsWith("验证R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        // 首验:AC pass 但漏报声明命令 → 应被判不予采信,进入修复
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("复验R")) {
        const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
        const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
        // 复验:合规回报(AC 全量 + 声明命令原样 pass)→ 必须放行
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [{ command: "mvn test", result: "pass", evidence: "BUILD SUCCESS" }],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files: {}, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      { requirement: "修复路径恢复测试", contract: contractOf(1, [], "standard") },
      env.glob,
      env.readFile,
      env.writeFile
    )
    const calls = logs.filter((l) => l.startsWith("AGENT")).map((l) => l.slice(7))
    console.log("首验漏报触发修复:", calls.some((c) => c.startsWith("修复R")) ? "PASS" : "FAIL")
    console.log(
      "复验合规后放行:",
      r.状态 === "可交付" && r.已证实 === 1 ? "PASS" : "FAIL " + r.状态
    )
  }
}

// ===== 场景11:同一显式合同重跑 → 按账本续跑,不得从零重置 =====
async function scenario11() {
  const files = {}
  const mkBehavior = () => (label, prompt) => {
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) {
      const pending = pendingFromPlanPrompt(prompt)
      // 每轮只认领第一条待证实标准(制造跨运行分批)
      return {
        strategy: "s",
        conventionsBrief: "公约",
        canImplement: true,
        blockers: [],
        packages: [
          {
            id: "pkg-" + pending[0],
            title: "包" + pending[0],
            objective: "o",
            acIds: [pending[0]],
            targetFiles: [],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ]
      }
    }
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
      const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    if (label === "需求成契") throw new Error("显式合同不应调用成契")
    throw new Error("未知 label: " + label)
  }
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: mkBehavior(), logs: logs1 })
  const r1 = await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    { requirement: "同合同续跑测试需求", contract: contractOf(2, [], "standard"), maxRounds: 1.9 }, // 小数轮次必须取整为 1
    env1.glob,
    env1.readFile,
    env1.writeFile
  )
  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: mkBehavior(), logs: logs2 })
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    {
      requirement: "同合同续跑测试需求",
      // 指纹鲁棒性:criteria 重排(显式 id 映射不变)+ 公约尾随空格,仍应判为同一合同
      contract: (() => {
        const base = contractOf(2, [], "standard")
        return {
          ...base,
          criteria: [base.criteria[1], base.criteria[0]],
          conventions: ["统一审计入口 "]
        }
      })()
    },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  console.log("\n== 场景11 同一显式合同续跑 ==")
  console.log(
    "首跑分批后如实 needs_fix:",
    r1.状态 === "需要修复" && r1.已证实 === 1 ? "PASS" : "FAIL " + r1.状态 + "/" + r1.已证实
  )
  console.log(
    "同指纹合同按账本续跑:",
    logs2.some((l) => l.includes("按同一合同续跑账本")) ? "PASS" : "FAIL"
  )
  console.log(
    "画像复用(无重复探索):",
    logs2.every((l) => !l.startsWith("AGENT: 探索：")) ? "PASS" : "FAIL"
  )
  console.log(
    "轮次续编且最终可交付:",
    r2.状态 === "可交付" && r2.已证实 === 2 && r2.轮次 === 2
      ? "PASS"
      : "FAIL " + r2.状态 + "/" + r2.已证实 + "/" + r2.轮次
  )
}

// ===== 场景12:同验收语义换元数据(档位/标题)→ 账本续跑 + 新元数据生效;含旧状态无指纹 fallback =====
async function scenario12() {
  const files = {}
  const mkBehavior = () => (label, prompt) => {
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) {
      const pending = pendingFromPlanPrompt(prompt)
      return {
        strategy: "s",
        conventionsBrief: "公约",
        canImplement: true,
        blockers: [],
        packages: [
          {
            id: "pkg-" + pending[0],
            title: "包" + pending[0],
            objective: "o",
            acIds: [pending[0]],
            targetFiles: [],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ]
      }
    }
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
      const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    if (label === "需求成契") throw new Error("显式合同不应调用成契")
    throw new Error("未知 label: " + label)
  }
  // 首跑:standard 档,只完成 AC-1(maxRounds:1 分批)
  const logs1 = []
  const env1 = makeEnv({ files, agentBehavior: mkBehavior(), logs: logs1 })
  await runScript(
    env1.agent,
    env1.parallel,
    env1.phase,
    env1.log,
    { requirement: "元数据切换测试需求", contract: contractOf(2, [], "standard"), maxRounds: 1 },
    env1.glob,
    env1.readFile,
    env1.writeFile
  )
  // 二跑:同 criteria,换 simple 档 + 新标题 → 账本续跑,新档位/标题生效
  const logs2 = []
  const env2 = makeEnv({ files, agentBehavior: mkBehavior(), logs: logs2 })
  const c2 = { ...contractOf(2, [], "simple"), title: "新标题合同" }
  const r2 = await runScript(
    env2.agent,
    env2.parallel,
    env2.phase,
    env2.log,
    { requirement: "元数据切换测试需求", contract: c2 },
    env2.glob,
    env2.readFile,
    env2.writeFile
  )
  console.log("\n== 场景12 元数据切换续跑 ==")
  console.log(
    "同指纹按账本续跑:",
    logs2.some((l) => l.includes("按同一合同续跑账本")) ? "PASS" : "FAIL"
  )
  console.log(
    "新档位生效(simple 直通,跳过规划代理):",
    logs2.some((l) => l.includes("复杂度档位：simple")) &&
      logs2.some((l) => l.includes("跳过规划代理"))
      ? "PASS"
      : "FAIL"
  )
  console.log("新标题生效:", r2.标题 === "新标题合同" ? "PASS" : "FAIL " + r2.标题)
  console.log(
    "进度未被重置(2/2 且可交付):",
    r2.已证实 === 2 && r2.状态 === "可交付" ? "PASS" : "FAIL " + r2.已证实 + "/" + r2.状态
  )

  // 12b:旧状态无 contractFingerprint(升级前写入)→ 现场回算 fallback,仍按同一合同续跑
  const files3 = {}
  const logsA = []
  const envA = makeEnv({ files: files3, agentBehavior: mkBehavior(), logs: logsA })
  await runScript(
    envA.agent,
    envA.parallel,
    envA.phase,
    envA.log,
    { requirement: "旧状态指纹测试需求", contract: contractOf(2, [], "standard"), maxRounds: 1 },
    envA.glob,
    envA.readFile,
    envA.writeFile
  )
  const stateKey = Object.keys(files3).find((k) => k.endsWith("状态.json"))
  const legacy = JSON.parse(files3[stateKey])
  delete legacy.contractFingerprint // 模拟升级前的旧状态
  files3[stateKey] = JSON.stringify(legacy)
  const logsB = []
  const envB = makeEnv({ files: files3, agentBehavior: mkBehavior(), logs: logsB })
  const rB = await runScript(
    envB.agent,
    envB.parallel,
    envB.phase,
    envB.log,
    { requirement: "旧状态指纹测试需求", contract: contractOf(2, [], "standard") },
    envB.glob,
    envB.readFile,
    envB.writeFile
  )
  console.log(
    "旧状态回算指纹仍续跑(不白重置):",
    logsB.some((l) => l.includes("按同一合同续跑账本")) && rB.已证实 === 2 && rB.状态 === "可交付"
      ? "PASS"
      : "FAIL " + rB.已证实 + "/" + rB.状态
  )
}

// ===== 场景13:档位升级重探(simple→standard) + 缺省元数据不改档 =====
async function scenario13() {
  console.log("\n== 场景13 档位升级重探 + 缺省元数据 ==")
  const mkBehavior = () => (label, prompt) => {
    if (label.startsWith("探索：")) return EXPLORE
    if (/^第\d+轮规划$/.test(label)) {
      const pending = pendingFromPlanPrompt(prompt)
      return {
        strategy: "s",
        conventionsBrief: "公约",
        canImplement: true,
        blockers: [],
        packages: [
          {
            id: "pkg-" + pending[0],
            title: "包" + pending[0],
            objective: "o",
            acIds: [pending[0]],
            targetFiles: [],
            validationCommands: [],
            dependencies: [],
            riskLevel: "low"
          }
        ]
      }
    }
    if (label.startsWith("实现R")) return IMPL_OK
    if (label.startsWith("验证R")) {
      const m = prompt.match(/"acIds":\s*\[([^\]]*)\]/)
      const acIds = m ? [...m[1].matchAll(/AC-\d+/g)].map((x) => x[0]) : []
      return {
        status: "pass",
        summary: "ok",
        perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
        commandChecks: [],
        issues: [],
        recommendedFixes: []
      }
    }
    if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
    if (label === "需求成契") throw new Error("显式合同不应调用成契")
    throw new Error("未知 label: " + label)
  }
  // 13a: simple 首跑(单视角画像,分批 1/2)→ 升 standard:必须重探(三视角)
  {
    const files = {}
    const logsA = []
    const envA = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsA })
    await runScript(
      envA.agent,
      envA.parallel,
      envA.phase,
      envA.log,
      { requirement: "档位升级测试需求", contract: contractOf(4, [], "simple"), maxRounds: 1 },
      envA.glob,
      envA.readFile,
      envA.writeFile
    )
    const exploreA = logsA.filter((l) => l.startsWith("AGENT: 探索：")).length
    const logsB = []
    const envB = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsB })
    await runScript(
      envB.agent,
      envB.parallel,
      envB.phase,
      envB.log,
      { requirement: "档位升级测试需求", contract: contractOf(4, [], "standard"), maxRounds: 1 },
      envB.glob,
      envB.readFile,
      envB.writeFile
    )
    const exploreB = logsB.filter((l) => l.startsWith("AGENT: 探索：")).length
    console.log("simple 首跑单视角:", exploreA === 1 ? "PASS" : "FAIL " + exploreA)
    console.log(
      "升级日志出现:",
      logsB.some((l) => l.includes("档位从 simple 升级")) ? "PASS" : "FAIL"
    )
    console.log("升 standard 重探三视角:", exploreB === 3 ? "PASS" : "FAIL " + exploreB)
    console.log(
      "账本仍续跑(非重置):",
      logsB.some((l) => l.includes("按同一合同续跑账本")) ? "PASS" : "FAIL"
    )
  }
  // 13c(旧状态兼容,检视方复现原样): simple 首跑后删掉 explorationComplexity 字段,
  // 升 standard 续跑仍必须重探(从状态中的合同档位回推)
  {
    const files = {}
    const logsA = []
    const envA = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsA })
    await runScript(
      envA.agent,
      envA.parallel,
      envA.phase,
      envA.log,
      {
        requirement: "旧状态画像档位测试需求",
        contract: contractOf(4, [], "simple"),
        maxRounds: 1
      },
      envA.glob,
      envA.readFile,
      envA.writeFile
    )
    const stateKey = Object.keys(files).find((k) => k.endsWith("状态.json"))
    const legacy = JSON.parse(files[stateKey])
    delete legacy.explorationComplexity // 模拟升级前的旧状态
    files[stateKey] = JSON.stringify(legacy)
    const logsB = []
    const envB = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsB })
    await runScript(
      envB.agent,
      envB.parallel,
      envB.phase,
      envB.log,
      {
        requirement: "旧状态画像档位测试需求",
        contract: contractOf(4, [], "standard"),
        maxRounds: 1
      },
      envB.glob,
      envB.readFile,
      envB.writeFile
    )
    const exploreLegacy = logsB.filter((l) => l.startsWith("AGENT: 探索：")).length
    console.log("旧状态缺字段仍触发重探:", exploreLegacy === 3 ? "PASS" : "FAIL " + exploreLegacy)
    console.log(
      "回推路径日志正确:",
      logsB.some((l) => l.includes("档位从 simple 升级")) ? "PASS" : "FAIL"
    )
  }
  // 13b: standard 首跑 → 二跑只传 criteria(缺省 complexity/title)→ 沿用旧档位与标题
  {
    const files = {}
    const logsA = []
    const envA = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsA })
    await runScript(
      envA.agent,
      envA.parallel,
      envA.phase,
      envA.log,
      { requirement: "缺省元数据测试需求", contract: contractOf(2, [], "standard"), maxRounds: 1 },
      envA.glob,
      envA.readFile,
      envA.writeFile
    )
    const base = contractOf(2, [], "standard")
    const minimal = {
      criteria: base.criteria,
      nonGoals: base.nonGoals,
      constraints: base.constraints,
      conventions: base.conventions,
      globalValidationCommands: base.globalValidationCommands
      // 故意不传 title/problem/goal/complexity
    }
    const logsB = []
    const envB = makeEnv({ files, agentBehavior: mkBehavior(), logs: logsB })
    const rB = await runScript(
      envB.agent,
      envB.parallel,
      envB.phase,
      envB.log,
      { requirement: "缺省元数据测试需求", contract: minimal },
      envB.glob,
      envB.readFile,
      envB.writeFile
    )
    console.log(
      "缺省 complexity 沿用旧档(standard,不降 simple):",
      logsB.some((l) => l.includes("复杂度档位：standard")) ? "PASS" : "FAIL"
    )
    console.log(
      "规划代理仍被调用(非 simple 直通):",
      logsB.some((l) => /AGENT: 第\d+轮规划/.test(l)) ? "PASS" : "FAIL"
    )
    console.log("缺省标题沿用旧标题:", rB.标题 === "测试合同" ? "PASS" : "FAIL " + rB.标题)
    console.log("最终可交付:", rB.状态 === "可交付" ? "PASS" : "FAIL " + rB.状态)
  }
}

// ===== 场景14:命令空白漂移不误判(归一化)+ 非法 complexity 必须报错 =====
async function scenario14() {
  console.log("\n== 场景14 命令空白归一化 + complexity 校验 ==")
  // 14a: 验证/终审代理回填的命令带空白漂移(前后空格、连续空格)——归一化后
  // 仍应命中声明命令,不得误判为"未执行"而拒绝放行。
  {
    const files = {}
    const logs = []
    const behavior = (label, prompt) => {
      if (label === "需求成契") return contractOf(2, ["mvn test"], "simple")
      if (label.startsWith("探索：")) return EXPLORE
      if (label.startsWith("实现R")) return IMPL_OK
      if (label.startsWith("验证R")) {
        const acIds = acIdsFromPrompt(prompt)
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [{ command: "  mvn   test ", result: "pass", evidence: "ok" }],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      if (label === "终审命令核对")
        return {
          summary: "ok",
          commands: [{ command: "mvn  test", passed: true, evidence: "BUILD SUCCESS" }]
        }
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      "契约测试需求空白归一",
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log(
      "空白漂移命令不误判为未执行:",
      r.状态 === "可交付" ? "PASS" : "FAIL " + r.状态 + " " + JSON.stringify(r.说明 || "")
    )
  }
  // 14b: complexity 拼写错误必须显式报错,绝不静默降级为自动判档。
  {
    const files = {}
    const logs = []
    const behavior = (label) => {
      if (label === "需求成契") return contractOf(2, ["mvn test"], "")
      throw new Error("不应到达: " + label)
    }
    const env = makeEnv({ files, agentBehavior: behavior, logs })
    let threw = ""
    try {
      await runScript(
        env.agent,
        env.parallel,
        env.phase,
        env.log,
        { requirement: "契约测试需求档位校验", complexity: "standrad" },
        env.glob,
        env.readFile,
        env.writeFile
      )
    } catch (e) {
      threw = String(e && e.message)
    }
    console.log(
      "非法 complexity 显式报错:",
      threw.includes("complexity 取值非法") ? "PASS" : "FAIL " + (threw || "未抛错")
    )
  }
  // 14c: 终审对同一声明命令重复上报(先 fail 后 pass)——聚合必须取"最坏",
  // pass 不得覆盖 fail,否则重跑刷绿即可绕过终审。
  {
    const files = {}
    const logs = []
    const behavior = (label, prompt) => {
      if (label.startsWith("探索：")) return EXPLORE
      if (label.startsWith("实现R")) return IMPL_OK
      if (label.startsWith("验证R")) {
        const acIds = acIdsFromPrompt(prompt)
        return {
          status: "pass",
          summary: "ok",
          perAc: acIds.map((id) => ({ id, result: "pass", evidence: "x.java:1" })),
          commandChecks: [{ command: "mvn test", result: "pass", evidence: "ok" }],
          issues: [],
          recommendedFixes: []
        }
      }
      if (label.startsWith("对抗复核")) return { summary: "ok", refutations: [] }
      if (label === "终审命令核对")
        return {
          summary: "重跑刷绿",
          commands: [
            { command: "mvn test", passed: false, evidence: "首跑挂了" },
            { command: "mvn test", passed: true, evidence: "重跑过了" }
          ]
        }
      if (label === "需求成契") throw new Error("外部合同注入时不应调用成契 agent")
      throw new Error("未知 label: " + label)
    }
    const env = makeEnv({ files, agentBehavior: behavior, logs })
    const r = await runScript(
      env.agent,
      env.parallel,
      env.phase,
      env.log,
      { requirement: "契约测试需求重复上报", contract: contractOf(1, ["mvn test"], "simple") },
      env.glob,
      env.readFile,
      env.writeFile
    )
    console.log(
      "重复上报取最坏(fail 不被 pass 覆盖):",
      r.状态 === "需要修复" && r.终审.some((item) => item.includes("mvn test → 失败"))
        ? "PASS"
        : "FAIL " + r.状态 + " " + JSON.stringify(r.终审 || [])
    )
  }
}

;(async () => {
  const prev = await scenario1()
  await scenario2(prev)
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
