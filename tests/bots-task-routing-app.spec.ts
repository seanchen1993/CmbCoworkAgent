/**
 * Opt-in routing evaluation through the real Electron App, Runtime and selected
 * model. Each case has a fresh Bot and synthetic workspace. No decision stubs,
 * fallback "create a task" messages, real IM or user-profile writes.
 *
 * Prepare: node --import tsx scripts/run-bot-integration-e2e.mjs --build-only
 * Run with BOT_TEST_APP_OUT, BOT_ROUTING_MODEL_PROFILE and BOT_ROUTING_MODEL_ID.
 * BOT_ROUTING_CASE optionally selects comma-separated case IDs. JSON records actual choices;
 * preferences are observations, while broken execution/lifecycle fails the run.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { _electron } from "playwright"
import { waitForBotAppState } from "./support/bot-app-state"
import { botTestAppOutput } from "./support/bot-test-app"
import { selectedBotRoutingModel } from "./support/bot-routing-model"
import { createBotExperimentArchive, experimentSha256 } from "./support/bot-experiment-archive.mjs"
import { parseBotWorkAttachmentHref } from "../src/shared/bots/work-history"
import { splitBotInlineReasoning } from "../src/shared/bots/inline-reasoning"
import { acceptedBotDispatch, hasOutstandingBotRequest } from "../src/main/agent/bot-dispatch-feedback"
import { installSlashSkillFixture, prdFixtureSkillName, slashSkillRequest, slashSkillRevisionRequest, slashSkillSelection, verifyPrdArtifact, verifySlashSkillResult, verifySlashSkillRevision } from "./support/bot-slash-skill-fixture"

type Route = "inline" | "independent" | "continue" | "background"
type Case = {
  id: string
  label: string
  preferred: Route
  files?: Record<string, string>
  skill?: typeof slashSkillSelection
  instructions?: string
  naturalSkill?: boolean
  message: (directory: string) => string
  verify?: (directory: string, result: any, data: any) => Promise<void> | void
}
function assertNodeTests(output: string, minimum: number): number {
  assert.match(output, /(?:#|ℹ) fail 0/)
  const count = Number(output.match(/(?:#|ℹ) tests (\d+)/)?.[1])
  assert.ok(count >= minimum, `expected at least ${minimum} actual tests, got ${count}`)
  return count
}
function assertRevisionDispatch(
  result: { mainToolCalls?: Array<{ name: string; args: { workId?: string; expectedVersion?: number } }>; toolErrors: unknown[] },
  workId: string,
  expectedVersion?: number
) {
  assert.ok(result.mainToolCalls, "record the main Bot's revision calls")
  const mutations = result.mainToolCalls.filter(call =>
    ["bot_work_send", "bot_work_continue", "bot_work_create"].includes(call.name))
  assert.deepEqual(mutations.map(call => call.name), ["bot_work_send"], "accept the revision with one send to the existing task")
  assert.equal(mutations[0].args.workId, workId)
  assert.equal(mutations[0].args.expectedVersion, expectedVersion, "only reopening requires the observed work version")
  assert.deepEqual(result.toolErrors, [], "a revision against the unchanged snapshot must succeed on its first attempt")
}
const eventFiles = {
  "活动约束.md":
    "虚构读书会：周日下午三点开始，共90分钟，20人，各带一本书。必须有签到、分组讨论和分享。预算1000元。\n",
  "场地说明.md":
    "社区阅览室免费，可容纳24人，室内不受天气影响。小公园免费、容量40人，下雨不可用。活动中心收费300元、容量30人，有投影。\n",
  "费用.csv": "项目,单价,数量\n饮用水,5,20\n材料,120,1\n备用金,100,1\n"
}
const reconciliationInputs = {
  "orders.csv": 'id,amount,note\nA,120.00,book\nB,80.00,book\nC,250.00,"card,blue"\nD,50.00,book\n',
  "payments.csv": "id,paid\nA,100.00\nA,20.00\nB,80.00\nC,200.00\nX,30.00\n"
}
const prdInputs = {
  "需求.md": "虚构图书借阅：每人最多同时借3本，借期14天，归还后才能再次借出。\n",
  "约束.md": "只做内部使用，不收罚款，逾期提醒。不要扩展采购或支付。\n",
  "现有接口.md": "已有查询图书库存接口，申请、归还和提醒功能待实现。\n"
}
async function verifyNaturalPrd(sourceDirectory: string, result: any, data: any) {
  assert.equal(result.selectedSkill, undefined)
  assert.equal(result.actual, result.id === "named-revision" ? "continue" : "independent")
  assert.equal(data.works.length, 1)
  // The user identified the input directory, not the executor's workspace.
  const receipt = await verifyPrdArtifact(data.works[0].workspace.path, result.id === "named-revision" ? 21 : 14)
  const calls = result.workToolCalls[0].calls
  assert.ok(calls.some((c: any) => c.name === "execute" && JSON.stringify(c.args).includes("verify.mjs")))
  assert.ok(calls.some((c: any) => c.name === "bot_deliver_files"))
  assert.equal(result.reportCount, 1)
  assert.match(result.reply, /\[prd\.md\]\(#bot-history\//i)
  assert.equal(result.returnedPrdSha256, receipt.sha256, "the parent's attachment must open the verified version")
  result.skillValidation = { scriptVerified: true, sha256: receipt.sha256, artifact: "prd.md", resultReported: true }
  assert.ok(!result.toolErrors.some((e: any) => e.tool === "bot_skill_dispatch"), "first skill dispatch must not require recovery")
  if (result.id === "lending-requirements") {
    assert.ok(!result.mainTools.includes("bot_skill_dispatch"), "the request did not name a skill")
    return
  }
  assert.ok(result.mainTools.includes("bot_skill_dispatch"), "observe a first-pass named skill handoff")
  assert.ok(!result.mainTools.some((tool: string) => ["bot_work_create", "bot_work_send"].includes(tool)))
  assert.equal(result.mainAcknowledgements.length, 1)
  assert.ok(!result.mainToolChoices.some((choice: any) => choice?.function?.name === "bot_skill_dispatch"), "plain text must keep autonomous routing")
  const hooks = (await readFile(join(dirname(sourceDirectory), "skill-lifecycle.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  const workerHooks = hooks.filter(h => h.sessionId === data.works[0].threadId)
  assert.ok(["PreSkillUse", "PostSkillUse"].every(event => workerHooks.some(h => h.event === event && h.trigger === "skill_select")))
  assert.ok(!hooks.some(h => data.tasks.some((t: any) => !t.workId && t.threadId === h.sessionId)))
  result.skillValidation.workerActivationVerified = true
  if (result.id === "named-schedule") {
    const schedule = data.schedules[0]
    const occurrences = data.tasks.filter((t: any) => t.origin.kind === "schedule")
    assert.equal(data.schedules.length, 1)
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0].workId, schedule.workId)
    assert.equal(occurrences[0].origin.explicitSkill.name, prdFixtureSkillName)
    assert.ok(!data.tasks.some((t: any) => t.origin.kind === "work"), "saving the schedule must not also dispatch immediate work")
  } else {
    const receipt = data.tasks.find((t: any) => t.origin.kind === "work" && t.requestId &&
      t.origin.dispatch === (result.id === "named-revision" ? "follow_up" : "create") && t.origin.sourceContext?.namedSkill?.name === prdFixtureSkillName)
    assert.ok(receipt, "host must retain the named skill for this worker assignment")
    if (result.id === "named-revision") assert.match(await readFile(join(data.works[0].workspace.path, "prd.md"), "utf8"), /21\s*天/)
  }
}
let browserFixtureUrl = ""
const logFixture = {
  "service.log": "08:12 batch=b1 code=EMPTY_BATCH itemCount=0\n09:27 key=day.csv code=NoSuchKey status=404\n",
  "batch.mjs": "export function validateBatch(items) { if (items.length === 0) throw new Error('EMPTY_BATCH') }\n"
}
function publishedLogReply(
  result: { reportCount: number },
  data: { messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }> }
) {
  assert.equal(result.reportCount, 1)
  const final = data.messages.findLast(m => m.role === "assistant" && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim())
  assert.ok(final && typeof final.content === "string", "the parent must publish an answer")
  const text = splitBotInlineReasoning(final.content).body
  assert.doesNotMatch(text, /review scope|in my own voice|let me (?:verify|check|compose)|requires structured input|bot_work_result_/, "internal narration in the published answer")
  assert.doesNotMatch(text, /任务可以结束|要我把.{1,45}整理成一份/, "a resolved question should end with the requested answer")
  return text
}
const cases: Case[] = [
  {
    id: "ops-log-triage", label: "自然语言排查当日服务异常", preferred: "independent",
    files: {
      "errors.json": JSON.stringify({ service: "orders_demo", code: "E_EMPTY_BATCH", count: 2 }),
      "batches.mjs": 'export function validateBatch(orders) { if (!orders.length) throw new Error("E_EMPTY_BATCH") }'
    },
    message: dir => `服务 orders_demo 今天有异常日志，分析日志给出原因和修复建议。代码地址：${dir}`,
    verify: (_dir, result, data) => {
      assert.doesNotMatch(result.message, /ops-log-triage|技能/)
      assert.deepEqual(result.mainTools, ["bot_work_create"], "dispatch the matching outcome before any foreground probe")
      assert.equal(result.budgetHandoff, false)
      assert.equal(result.mainModelRequests, 1)
      assert.equal(data.works.length, 1)
      assert.equal(result.mainAcknowledgements.length, 1)
      assert.ok(result.mainAcknowledgements[0].afterDispatch)
      assert.ok(result.mainAcknowledgements[0].text.length <= 80)
      assert.doesNotMatch(result.mainAcknowledgements[0].text, /finishTurn|pipeline|Let me|预算/i)
      const worker = data.workMessages[0]
      assert.ok(worker.some((m: any) => m.tool_calls?.some((c: any) =>
        c.name === "read_file" && JSON.stringify(c.args).includes("ops-log-triage/SKILL.md"))))
      assert.ok(worker.some((m: any) => m.role === "tool" && m.name === "execute" && !m.is_error &&
        String(m.content).includes("OPS_CHECK:orders_demo:E_EMPTY_BATCH:2")), "the worker ran the skill resource")
      assert.equal(result.reportCount, 1)
      const reply = publishedLogReply(result, data)
      assert.match(reply, /E_EMPTY_BATCH/)
      assert.match(reply, /空批|空(?:数组|列表)|批次.{0,14}(?:为空|为零|为 0)|!orders\.length/)
      assert.doesNotMatch(reply, /OPS_CHECK:/, "report the business error, not the skill script's success marker")
    }
  },
  {
    id: "delivery-log-cause", label: "日志汇报保留错误码、原因和建议", preferred: "independent",
    files: logFixture,
    message: dir => `请用独立任务检查 ${dir} 的 service.log 和 batch.mjs，告诉我第一条异常的错误码、触发原因和调用方应该怎么处理。`,
    verify: (_dir, result, data) => {
      const reply = publishedLogReply(result, data)
      assert.match(reply, /EMPTY_BATCH/)
      assert.match(reply, /空|为\s*0|等于\s*0/)
      assert.match(reply, /校验|跳过|检查|拦截|判断|判空|验证|过滤|提前返回/)
      assert.doesNotMatch(reply, /read_file|工具权限|工具不可用/)
    }
  },
  {
    id: "delivery-log-gap", label: "证据不足时说明还缺哪条记录", preferred: "independent",
    files: { "service.log": logFixture["service.log"] },
    message: dir => `请用独立任务核对 ${dir} 的 service.log。NoSuchKey 可以证明 day.csv 被删除了吗？给出这条记录能支持的判断及还需要什么证据。`,
    verify: (_dir, result, data) => {
      const reply = publishedLogReply(result, data)
      assert.match(reply, /NoSuchKey/)
      assert.match(reply, /不能|无法|不足|不代表|并不|未能|不可|仅(?:能|说明|表明)|只能|并非/)
      assert.match(reply, /审计|操作记录|删除记录|操作日志|版本|DeleteObject/i)
      assert.doesNotMatch(reply, /read_file|工具权限|工具不可用/)
    }
  },
  {
    id: "delivery-log-method", label: "用户询问方法时给出实际工具名", preferred: "independent",
    files: { "service.log": logFixture["service.log"] },
    message: dir => `请让独立任务用 read_file 读取 ${dir}/service.log。告诉我第一条错误码，以及实际用了哪个工具读取文件。`,
    verify: (_dir, result, data) => {
      assert.ok(data.workMessages.flat().some((m: any) => m.role === "tool" && m.name === "read_file" && !m.is_error && m.status !== "error"))
      const reply = publishedLogReply(result, data)
      assert.match(reply, /EMPTY_BATCH/)
      assert.match(reply, /\bread_file\b/)
    }
  },
  {
    id: "delivery-review", label: "主 Bot 复核正式附件后交付", preferred: "independent",
    files: { "counts.txt": "上午 7 件，下午 4 件。" },
    message: dir => `在工作目录 ${dir} 读取 counts.txt，生成 total.md，写明上午、下午及全天总件数。请你作为主 Bot 在发之前独立复核一次文件里的算术，再把正式附件和结论发回来。`,
    verify: async (dir, result) => {
      assert.equal(result.actual, "independent")
      assert.ok(result.reviewCount > 0, "independent review requested at admission")
      assert.ok(result.reviewedFixtureFiles.includes("total.md"), "the independent reviewer must receive the actual retained figures")
      assert.match(await readFile(join(dir, "total.md"), "utf8"), /11|十一/)
      assert.match(result.reply, /11|十一/)
    }
  },
  {
    id: "delivery-confirm", label: "复核后等本人批准再发送", preferred: "independent",
    files: { "counts.txt": "上午 7 件，下午 4 件。" },
    message: dir => `在工作目录 ${dir} 读 counts.txt，算好全天总数，生成 approval.md。请主 Bot 独立复核文件。发前务必先让我本人确认，确认后再把结果和附件发回。`,
    verify: async (dir, result, data) => {
      assert.ok(result.reviewCount > 0)
      assert.equal(result.confirmCount, 1, "one answered host release confirmation")
      assert.equal(result.reportCount, 1, "one final publication after human confirmation")
      assert.ok(result.reviewedFixtureFiles.includes("approval.md"), "the reviewer must see the formal document before the owner is asked")
      assert.doesNotMatch(result.reply, /\[counts\.txt\]\(#bot-history\//, "a source file is not a requested deliverable")
      const released = data.messages.findLast((m: any) => m.role === "assistant" && typeof m.content === "string" &&
        m.content.includes("[approval.md](#bot-history/"))
      assert.ok(released, "the approved text must be the message carrying the formal attachment")
      assert.doesNotMatch(released.content, /等[您你].{0,8}(?:确认|批准).{0,6}再发|确认后我再发|需要我现在发布|是否(?:确认|同意)(?:发送|发布)/u,
        "the released message must not ask for the same release a second time")
      assert.match(await readFile(join(dir, "approval.md"), "utf8"), /11|十一/)
      assert.match(result.reply, /approval\.md/)
    }
  },
  {
    id: "browser-lookup",
    label: "自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传",
    preferred: "independent",
    message: () => `打开 ${browserFixtureUrl} 看一下今天的代发情况，告诉我总笔数和总金额。`,
    verify: (_directory, result, data) => {
      assert.equal(result.actual, "independent")
      assert.equal(result.budgetHandoff, false)
      assert.ok(!result.mainTools.includes("bot_browser"))
      assert.ok(!result.mainTools.includes("bot_request_browser_help"))
      assert.ok(result.tools.includes("bot_browser"), "the task must use its real browser")
      assert.ok(result.reportCount > 0, "the task result must reach the main conversation")
      assert.match(result.reply, /37/)
      assert.match(result.reply, /(?:128,?640|12\.864)/)
      assert.ok(data.workMessages.flat().some((message: any) =>
        message.role === "tool" && message.name === "bot_browser" &&
        typeof message.content === "string" && message.content.includes("128640")
      ), "verify the actual task browser receipt, not only the model's claim")
    }
  },
  {
    id: "document-inputs", label: "材料准备", preferred: "inline", naturalSkill: true,
    message: () => "你这里把需求整理成 PRD 的技能，需要我准备哪几个输入文件？我只想知道文件名。",
    verify: (_dir, result, data) => {
      assert.equal(result.selectedSkill, undefined)
      assert.equal(result.actual, "inline")
      assert.equal(data.works.length, 0)
      for (const filename of Object.keys(prdInputs)) assert.ok(result.reply.includes(filename))
      assert.ok(!result.tools.some((name: string) => ["write_file", "edit_file", "bot_deliver_files"].includes(name)))
    }
  },
  {
    id: "named-skill-help", label: "点名咨询输入", preferred: "inline", naturalSkill: true,
    message: () => `使用 ${prdFixtureSkillName} 技能需要准备哪些材料？只告诉我文件名，这次不用生成文档。`,
    verify: (_dir, result, data) => {
      assert.equal(result.actual, "inline")
      assert.equal(data.works.length, 0)
      assert.ok(!result.mainTools.includes("bot_skill_dispatch"))
      for (const name of Object.keys(prdInputs)) assert.ok(result.reply.includes(name))
    }
  },
  {
    id: "named-schedule", label: "定时需求文档", preferred: "independent", naturalSkill: true, files: prdInputs,
    message: dir => `安排一次例行，从现在起30秒后使用 ${prdFixtureSkillName} 技能，在工作目录 ${dir} 读取材料生成并校验 prd.md，完成后把文件发给我。`,
    verify: verifyNaturalPrd
  },
  {
    id: "library-brief", label: "借阅需求", preferred: "independent", naturalSkill: true, files: prdInputs,
    message: dir => `用 ${prdFixtureSkillName} 技能，把 ${dir} 里的材料整理成 prd.md，校验后把文件发给我。`,
    verify: verifyNaturalPrd
  },
  {
    id: "lending-requirements", label: "借阅规则", preferred: "independent", naturalSkill: true, files: prdInputs,
    message: dir => `把 ${dir} 里的需求、约束和接口说明整理成一份产品需求文档 prd.md，检查完把文件发给我。`,
    verify: verifyNaturalPrd
  },
  {
    id: "slash-skill-natural",
    skill: slashSkillSelection,
    label: "仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序",
    preferred: "independent",
    files: prdInputs,
    message: (directory) => slashSkillRequest(directory, false),
    verify: (directory, result, data) => verifySlashSkillResult(directory, result, data, false)
  },
  {
    id: "slash-skill",
    skill: slashSkillSelection,
    label: "主 Bot 斜杠技能选择、独立任务激活及文件回传",
    preferred: "independent",
    files: prdInputs,
    message: slashSkillRequest,
    verify: verifySlashSkillResult
  },
  {
    id: "greeting",
    label: "日常问答",
    preferred: "inline",
    message: () => "你好，用一句话说说你能帮我做什么。"
  },
  {
    id: "rewrite",
    label: "短文改写",
    preferred: "inline",
    message: () => "把这句话改得更礼貌，只给一句：明天下午三点来参加读书会，记得带书。"
  },
  {
    id: "lookup",
    label: "读取一个文件查事实",
    preferred: "inline",
    files: { "场地.md": "阅览室最多容纳24人，免费，周一闭馆。\n" },
    message: (dir) => `看一下 ${dir}/场地.md，告诉我阅览室最多能坐多少人。一句话即可。`,
    verify: (_dir, result) => assert.match(result.reply, /24/)
  },
  {
    id: "short-shell",
    label: "短 Shell 查询",
    preferred: "inline",
    message: (dir) => `在 ${dir} 执行 node -p '2 + 3'，告诉我实际输出；不用写文件。`,
    verify: (_dir, result) => {
      assert.ok(result.tools.includes("execute"), "must execute the requested short command")
      assert.match(result.reply, /5/)
    }
  },
  {
    id: "small-edit",
    label: "文件中修改一个时间",
    preferred: "inline",
    files: { "notice.txt": "读书会本周日下午三点开始，地点社区阅览室。\n" },
    message: (dir) => `把 ${dir}/notice.txt 中的下午三点改成下午四点，其他内容不变。`,
    verify: async (dir) =>
      assert.equal(
        await readFile(join(dir, "notice.txt"), "utf8"),
        "读书会本周日下午四点开始，地点社区阅览室。\n"
      )
  },
  {
    id: "event-plan",
    label: "多材料筹备方案及交付",
    preferred: "independent",
    files: eventFiles,
    message: (dir) =>
      `请帮我做好周日读书会筹备方案。工作目录 ${dir}。读取活动约束.md、场地说明.md、费用.csv，核算费用，比较三个场地的容量、预算和天气风险，推荐一个；制定90分钟流程、分工清单和两条应急安排。写入 plan.md，检查总时长和预算后交给我。后面我会调整时间。资料均为虚构，不用浏览器，也不联系任何人。`,
    verify: async (dir) => {
      const plan = await readFile(join(dir, "plan.md"), "utf8")
      assert.match(plan, /90/)
      assert.match(plan, /320|620/)
      assert.match(plan, /15[:：]00|三点|下午\s*3/)
    }
  },
  {
    id: "background-plan",
    label: "自然要求后台推进方案",
    preferred: "independent",
    files: eventFiles,
    message: (dir) =>
      `帮我把周日读书会的筹备方案做好，先放后台推进，做好了告诉我，我这边还要继续聊别的事情。工作目录 ${dir}，资料是活动约束.md、场地说明.md、费用.csv。比较三个场地并推荐一个，核算费用，制定90分钟流程、分工清单和两条应急安排，写入 plan.md，检查总时长和预算后交给我。后面我会调整时间。均为虚构资料，不访问网络或联系别人。`,
    verify: async (dir) => {
      const plan = await readFile(join(dir, "plan.md"), "utf8")
      assert.match(plan, /90/)
      assert.match(plan, /320|620/)
      assert.match(plan, /15[:：]00|三点|下午\s*3/)
    }
  },
  {
    id: "reconcile",
    label: "跨文件核对数据并输出报告",
    preferred: "independent",
    files: {
      "orders.csv": "id,amount\nA,120\nB,80\nC,250\nD,50\n",
      "payments.csv": "id,paid\nA,120\nB,80\nC,200\nX,30\n"
    },
    message: (dir) =>
      `工作目录 ${dir} 有 orders.csv 和 payments.csv。帮我核对每个订单的实收与应收，找出少付、未付和无对应订单的记录，验证合计能对上，生成 reconciliation.md 报告给我。数据是虚构的，不访问其他目录或网络。`,
    verify: async (dir) => {
      const report = await readFile(join(dir, "reconciliation.md"), "utf8")
      for (const text of [/500/, /430/, /C/, /D/, /X/]) assert.match(report, text)
    }
  },
  {
    id: "code-fix",
    label: "修复代码并运行验证",
    preferred: "independent",
    files: {
      "discount.mjs": "export function payable(cents, percent) { return cents * (1 - percent); }\n",
      "discount.test.mjs":
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { payable } from './discount.mjs';\ntest('20% off', () => assert.equal(payable(1000, 20), 800));\ntest('round cents', () => assert.equal(payable(999, 15), 849));\ntest('zero', () => assert.equal(payable(0, 20), 0));\n"
    },
    message: (dir) =>
      `帮我修复 ${dir} 这个示例项目的折扣计算。payable 的第一个参数是整数分，第二个是0到100的折扣百分数，结果四舍五入到整数分。先复现失败，再修代码、补100%折扣的边界用例，用 node --test discount.test.mjs 验证。最后给出改动和测试结果，不提交Git，不装依赖。`,
    verify: async (dir, result) => {
      const { payable } = await import(join(dir, "discount.mjs") + "?" + Date.now())
      assert.equal(payable(1000, 20), 800)
      assert.equal(payable(999, 15), 849)
      assert.equal(payable(1000, 100), 0)
      result.verifiedNodeTests = assertNodeTests(execFileSync(process.execPath, ["--test", "discount.test.mjs"], {
        cwd: dir, encoding: "utf8"
      }), 4)
      assert.ok(result.tools.includes("execute"), "must actually run verification")
    }
  },
  {
    id: "reconciliation-cli",
    label: "从零实现可复用的对账工具",
    preferred: "independent",
    files: {
      "README.md": "# CSV 对账工具\n待实现。所有样本为虚构数据。\n",
      ...reconciliationInputs
    },
    message: (dir) =>
      `帮我把 ${dir} 做成一个能重复使用的 CSV 对账小项目。实现 reconcile.mjs 命令行：node reconcile.mjs orders.csv payments.csv report.json。保留现有两个 CSV 的原始内容，用它们生成样本报告；额外测试数据放到测试用例中。按订单汇总多笔支付，找出少付、未付、超付和无订单的支付；以整数分计算金额，支持带引号和逗号的CSV字段、CRLF、中文备注，拒绝非法金额和重复订单ID。report.json 中至少包含 orderTotalCents、paymentTotalCents 和 discrepancies，每个差异有 id 和 deltaCents（实收减应收）。用 Node 自带测试框架补至少8个用例，覆盖正常数据与这些边界，真正跑过测试及示例命令。完善 README 的用法和限制，交付代码、测试及样本报告。只用标准库，不装依赖、不提交Git、不访问网络或其他目录。`,
    verify: async (dir, result) => {
      for (const [name, text] of Object.entries(reconciliationInputs))
        assert.equal(await readFile(join(dir, name), "utf8"), text, "original input must be preserved")
      execFileSync(
        process.execPath,
        ["reconcile.mjs", "orders.csv", "payments.csv", "verified-report.json"],
        { cwd: dir }
      )
      const report = JSON.parse(await readFile(join(dir, "verified-report.json"), "utf8"))
      assert.equal(report.orderTotalCents, 50000)
      assert.equal(report.paymentTotalCents, 43000)
      for (const [id, delta] of [
        ["C", -5000],
        ["D", -5000],
        ["X", 3000]
      ] as const)
        assert.equal(report.discrepancies.find((d: any) => d.id === id)?.deltaCents, delta)
      const output = execFileSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" })
      result.verifiedNodeTests = assertNodeTests(output, 8)
      result.verifiedCliTotals = {
        orderTotalCents: report.orderTotalCents,
        paymentTotalCents: report.paymentTotalCents
      }
      assert.ok(result.tools.includes("execute"), "must execute tests, not only describe them")
    }
  },
  {
    id: "explicit-inline",
    label: "多步分析但用户指定主对话",
    preferred: "inline",
    files: eventFiles,
    message: (dir) =>
      `就在主对话完成，不要创建独立任务。读取 ${dir} 的活动约束.md、场地说明.md、费用.csv，核算总费用，比较三个场地并推荐一个，回复一个90分钟的读书会流程。只需简短文字，不写文件。`
  },
  {
    id: "explicit-task",
    label: "简单工作但用户要求独立任务",
    preferred: "independent",
    message: () =>
      "请单独创建一个任务，写一条40字以内的读书会通知：周日三点、社区阅览室、每人带一本书。只需要文字，之后我会在那个任务里修改。"
  },
  {
    id: "background-command",
    label: "单条耗时命令",
    preferred: "background",
    files: { "slow-check.mjs": "setTimeout(() => console.log('CHECK_OK'), 12000)\n" },
    message: (dir) =>
      `运行 node ${dir}/slow-check.mjs 这个本地检查脚本，预计十几秒，返回 CHECK_OK 就告诉我。只运行这条命令，不修改脚本或其他文件。`,
    verify: (_dir, result) => {
      assert.match(result.reply, /CHECK_OK/)
      if (result.actual === "background") assert.ok(result.backgroundReportCount > 0)
    }
  }
]

const diagnostic = cases.find(c => c.id === "ops-log-triage")!
const colleagueVoice = "用中文协助用户，像一起值班的同事，说话简洁。我的习惯是在接下工作和汇报结果时称对方为“搭档”。"
cases.push({
  ...diagnostic, id: "ops-log-colleague", label: "同一异常用值班搭档口吻答复", instructions: colleagueVoice,
  verify: async (dir, result, data) => {
    await diagnostic.verify!(dir, result, data)
    assert.match(result.mainAcknowledgements[0].text, /搭档/)
    assert.match(publishedLogReply(result, data), /搭档/)
  }
}, {
  id: "separate-answer", label: "交办后回答另一道独立问题", preferred: "independent",
  message: () => "给我开一个任务，用一句话写一则周五读书会通知，写好发回。同时请你现在单独回答另一个问题：19 加 23 是多少？不要把算术交给写通知的人。",
  verify: (_dir, result, data) => {
    assert.equal(data.works.length, 1)
    assert.equal(result.reportCount, 1)
    assert.match(result.mainAcknowledgements.map((m: any) => m.text).join(" "), /42|四十二/)
    assert.match(publishedLogReply(result, data), /读书会/)
  }
}, {
  id: "style-format", label: "用户指定格式优先于默认语气", preferred: "inline", instructions: colleagueVoice,
  message: () => "请用一个英文单词回答 2 加 3 等于多少，只写那个词。",
  verify: (_dir, result, data) => {
    const answer = data.messages.findLast((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())
    assert.match(splitBotInlineReasoning(answer.content).body.trim(), /^five[.!]?$/i)
    assert.equal(result.mainTools.length, 0)
  }
})
async function main(archive: Awaited<ReturnType<typeof createBotExperimentArchive>>) {
  const config = await selectedBotRoutingModel()
  const out = botTestAppOutput()
  const root = await mkdtemp(join(tmpdir(), "bot-routing-cases-"))
  await chmod(root, 0o700)
  const selected = process.env.BOT_ROUTING_CASE
    ? cases.filter(c => process.env.BOT_ROUTING_CASE!.split(",").includes(c.id))
    : cases
  assert.ok(selected.length, "unknown case")
  if (selected.some(test => test.skill || test.naturalSkill))
    await installSlashSkillFixture(root)
  if (selected.some(test => test.id.startsWith("ops-log-"))) {
    const directory = join(root, "profile", "skills", "ops-log-triage")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), [
      "---", "name: ops-log-triage", "description: 排查指定服务的当日异常日志，结合代码给出异常原因和修复建议。", "---",
      "用 node 执行本技能目录的 inspect.mjs，传入用户提供的数据目录。脚本读取本地合成日志，输出服务、错误码和次数。",
      "E_EMPTY_BATCH 表示调用方传入了空批次。按脚本的回执给出次数、原因及调用方建议。"
    ].join("\n"))
    await writeFile(join(directory, "inspect.mjs"), [
      'import { readFileSync } from "node:fs"',
      'import { join } from "node:path"',
      'const e = JSON.parse(readFileSync(join(process.argv[2], "errors.json"), "utf8"))',
      'console.log(["OPS_CHECK", e.service, e.code, e.count].join(":"))'
    ].join("\n"))
  }
  await archive.configure({ model: config.model, out, workspace: root, apiKey: config.apiKey })
  const reportPath = join(out, "artifacts", `routing-${Date.now()}.json`)
  const results: any[] = []
  const initialization = { cancelledIntroductionQuestions: [] as string[] }
  let activeTurn: { id: string; label: string; preferred: Route; message: string; selectedSkill?: string } | undefined
  const mainPrefixes = new Map<string, { system: string; tools: string; messages: any[] }>()
  const reviewedFixtureFiles = new Map<string, Set<string>>()
  const deliveryInputs = new Map<string, { requiredFiles?: string[]; stagedFiles?: string[]; selectionReason?: string }>()
  const wire = {
    reviewRequests: [] as string[][],
    reportPrefixChecks: [] as Array<{
      privatePreview: boolean; changedSchemas: string[]; role: "review" | "report"; systemUnchanged: boolean; toolsUnchanged: boolean; toolChoice: unknown;
      systemSha256: string; toolsSha256: string; reusedHistoryMessages: number
    }>,
    communicationRequests: [] as Array<{ at: number; user: string; choice: unknown }>,
    main: 0, guided: 0, mainPlanner: 0, mainBrowserTools: 0, worker: 0, workerCreate: 0, hostInputs: 0,
    firstRequestByRole: {} as Record<string, {
      system: string; tools: string[]; model?: string;
      temperature?: number; topP?: number; maxTokens?: number; seed?: number; thinking?: unknown; parallelToolCalls?: boolean; streaming?: boolean
    }>
  }
  // Transparent forwarding: no prompt/tool rewriting and no model decisions mocked.
  let providerPaymentRequired = false
  const relay = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/browser-fixture") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end("<!doctype html><title>虚构代发日报</title><h1>今日代发</h1><p>总笔数：37 笔</p><p>总金额：128640 元</p><p>本页面仅为本地测试数据。</p>")
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      const body = JSON.parse(raw.toString())
      const system = (body.messages ?? [])
        .filter((m: any) => m.role === "system")
        .map((m: any) => JSON.stringify(m.content))
        .join("\n")
      const create = (body.tools ?? []).some((t: any) => t.function?.name === "bot_work_create")
      const latestInput = (body.messages ?? []).findLast((m: any) => m.role === "user" && !(typeof m.content === "string" && m.content.trimStart().startsWith("<bot_reply_reminder>")))
      const inputText = typeof latestInput?.content === "string" ? latestInput.content
        : (latestInput?.content ?? []).map((part: any) => part.text ?? "").join("\n")
      const resultEvent = /<bot_runtime_context event="task_result(?:_review)?">/.test(inputText)
      const resultLine = resultEvent && inputText.split("\n").find(part => part.startsWith('{"kind":"host_work_result"'))
      const role = system.includes("ALREADY inside independent task") ? "executor"
        : resultLine ? "review" : resultEvent ? "report"
        : ['user_request', 'introduction'].some(event => inputText.includes(`<bot_runtime_context event="${event}">`)) ? "communication"
        : create ? "other-main" : "other"
      const botIdentity = (body.messages ?? []).filter((m: any) => m.role === "system")
        .map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("\n"))
        .join("\n").match(/Your stable Bot ID is "([^"]+)"/)?.[1]
      const tools = JSON.stringify(body.tools ?? [])
      if (botIdentity && role === "communication" && inputText.includes('<bot_runtime_context event="user_request">')) {
        mainPrefixes.set(botIdentity, { system, tools, messages: body.messages })
      }
      if (botIdentity && (role === "report" || role === "review")) {
        const previous = mainPrefixes.get(botIdentity)
        if (previous) {
          let reusedHistoryMessages = 0
          const previousHistory = previous.messages.filter((m: any) => m.role !== "system")
          const nextHistory = body.messages.filter((m: any) => m.role !== "system")
          while (reusedHistoryMessages < previousHistory.length &&
            JSON.stringify(previousHistory[reusedHistoryMessages]) === JSON.stringify(nextHistory[reusedHistoryMessages])) {
            reusedHistoryMessages++
          }
          const previousTools = JSON.parse(previous.tools)
          wire.reportPrefixChecks.push({
            privatePreview: role === "review" && inputText.includes('"confirmBeforeSending":true'),
            changedSchemas: (body.tools ?? []).filter((tool: any, index: number) =>
              JSON.stringify(tool) !== JSON.stringify(previousTools[index])).map((tool: any) => tool.function?.name),
            role, systemUnchanged: system === previous.system, toolsUnchanged: tools === previous.tools,
            toolChoice: body.tool_choice, systemSha256: experimentSha256(system),
            toolsSha256: experimentSha256(tools), reusedHistoryMessages
          })
        }
      }
      if (role === "review") {
        wire.reviewRequests.push((body.tools ?? []).map((tool: any) => tool.function.name))
        const returned = resultLine && JSON.parse(resultLine)
        const evidence = returned?.independentFile
        if (returned && activeTurn?.id.startsWith("delivery-")) deliveryInputs.set(activeTurn.id, {
          requiredFiles: returned.delivery?.requiredFiles, stagedFiles: returned.retainedFiles?.names, selectionReason: returned.selectionReason
        })
        if (activeTurn && evidence?.status === "ok" && !evidence.truncated &&
            /7|七/.test(evidence.text) && /4|四/.test(evidence.text) && /11|十一/.test(evidence.text)) {
          const files = reviewedFixtureFiles.get(activeTurn.id) ?? new Set<string>()
          files.add(evidence.name)
          reviewedFixtureFiles.set(activeTurn.id, files)
        }
      }
      if (role === "communication")
        wire.communicationRequests.push({ at: Date.now(), choice: body.tool_choice, user: inputText })
      // One actual system prompt/tool set per role, never headers or credentials.
      // All conversations in this harness are synthetic and isolated.
      wire.firstRequestByRole[role] ??= {
        system, tools: (body.tools ?? []).map((tool: any) => tool.function?.name).filter(Boolean),
        model: body.model, temperature: body.temperature, topP: body.top_p,
        maxTokens: body.max_tokens ?? body.max_completion_tokens, seed: body.seed,
        thinking: body.thinking, parallelToolCalls: body.parallel_tool_calls, streaming: body.stream
      }
      if (system.includes("ALREADY inside independent task")) {
        wire.worker++
        if (system.includes("## Host-linked original request and context")) wire.hostInputs++
        if (create) wire.workerCreate++
      } else if (create) {
        wire.main++
        await writeFile(join(out, "artifacts", "routing-main-system.txt"), system)
        if (role === "communication") {
          wire.guided++
          if ((body.tools ?? []).some((t: any) => t.function?.name === "write_todos")) wire.mainPlanner++
          if ((body.tools ?? []).some((t: any) => /browser|playwright|puppeteer|selenium|computer/i.test(t.function?.name ?? ""))) wire.mainBrowserTools++
        }
      }
      const response = await fetch(config.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body: raw,
        signal: AbortSignal.timeout(180000)
      })
      if (response.status === 402) providerPaymentRequired = true
      assert.ok(response.body)
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json"
      })
      await pipeline(Readable.fromWeb(response.body as any), res)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end("real-model relay failed")
    }
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const address = relay.address()
  assert.ok(address && typeof address !== "string")
  browserFixtureUrl = `http://127.0.0.1:${address.port}/browser-fixture`
  const env: Record<string, string> = {}
  for (const key of ["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!
  const binary = createRequire(import.meta.url)("electron") as string
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(root, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext"
  })
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const report = () => ({
    model: config.model,
    fixtureApprovalMode: "yolo (disposable profile only)",
    responsivenessProbe: process.env.BOT_ROUTING_PROBE_RESPONSIVENESS === "1",
    wire,
    results,
    initialization,
    activeTurn
  })
  const save = async () => {
    await writeFile(
      reportPath,
      JSON.stringify(report(), null, 2).replaceAll(root, "<test-workspace>")
    )
    await archive.checkpoint(report())
  }
  try {
    app = await _electron.launch({
      executablePath: binary,
      args: [join(out, "main/index.js"), "--user-data-dir=" + join(root, "electron")],
      cwd: resolve("."),
      env,
      timeout: 60000
    })
    app.process().stdout?.resume()
    app.process().stderr?.resume()
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false)
    })
    const page = await app.firstWindow()
    await page.getByText("新任务", { exact: true }).first().waitFor({ timeout: 60000 })
    await page.evaluate(() => {
      ;(globalThis as any).__name = (v: unknown) => v
    })
    await page.evaluate(
      async (config) => {
        await (window as any).api.models.setCustomConfig(config)
        await (window as any).api.models.setDefault("custom:" + config.id)
        // These synthetic workspaces are disposable and all edits/commands here
        // are test-authorized. Never change the actual user's approval settings.
        // Normal approval/resume behavior is covered by bots-local-work-app.
        await (window as any).api.sandbox.setYoloMode(true)
      },
      { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-relay-only" }
    )
    const send = (botId: string, message: string) =>
      page.evaluate(async (input) => (window as any).api.bots.send(input), {
        botId,
        message,
        requestId: randomUUID()
      })
    const snapshot = (bot: any) =>
      page.evaluate(async (bot) => {
        const api = (window as any).api
        const works = (await api.bots.works.list(bot.id)).items
        const state = await api.bots.snapshot()
        return {
          works,
          schedules: state.schedules.filter((s: any) => s.botId === bot.id),
          tasks: state.tasks.filter((t: any) => t.botId === bot.id),
          backgroundActive: state.backgroundThreads.includes(bot.threadId),
          messages: await api.threads.getMessages(bot.threadId),
          workMessages: await Promise.all(
            works.map((w: any) => api.threads.getMessages(w.threadId))
          )
        }
      }, bot)
    const settle = async (botId: string, initializing = false, previousTasks?: Set<string>) => {
      const deadline = Date.now() + 360000
      while (Date.now() < deadline) {
        const tasks = await page.evaluate(async id =>
          (await (window as any).api.bots.snapshot()).tasks.filter((t: any) => t.botId === id), botId)
        const busy = tasks.filter((t: any) => ["queued", "running", "waiting_user"].includes(t.state))
        // A model may ask an onboarding question before the actual case is sent.
        // Skip only that fixture setup turn, never a case's real question/approval.
        if (initializing) {
          for (const task of busy.filter((t: any) => t.origin.kind === "introduction" && t.state === "waiting_user")) {
            initialization.cancelledIntroductionQuestions.push(task.id)
            await page.evaluate(async (id) => (window as any).api.bots.cancel(id), task.id)
            await save()
          }
        }
        if (activeTurn?.id === "delivery-confirm") {
          for (const pending of busy.filter((t: any) => t.state === "waiting_user" && t.origin.review?.phase === "confirm")) {
            const answered = await page.evaluate(async ({ worker, parent }) => {
              const api = (window as any).api
              const request = await api.userInput.getPending(worker)
              if (!request || request.kind !== "bot_result_confirmation") return false
              const history = await api.threads.getMessages(parent)
              const premature = history.some((m: any) => m.role === "assistant" &&
                typeof m.content === "string" && (m.content.includes("?attachment=") || /(?:全天|合计|总数)[^。\n]{0,25}(?:11|十一)/.test(m.content)))
              if (premature) throw new Error("Final answer or attachment visible before approval")
              const question = request.questions[0]
              api.userInput.sendResponse({ requestId: request.requestId, answers: { [question.id]: {
                type: "option", questionId: question.id, optionIndex: 0, label: question.options[0].label
              } } })
              return true
            }, { worker: pending.threadId, parent: (await page.evaluate(async id =>
              (await (window as any).api.bots.snapshot()).bots.find((b: any) => b.id === id)?.threadId, botId)) })
            if (answered) console.log("Confirmed frozen publication after checking parent transcript")
          }
        }
        const fresh = previousTasks ? tasks.filter((t: any) => !previousTasks.has(t.id)) : []
        const produced = fresh.some((t: any) => t.workId && t.origin.kind === "work" && t.state === "completed")
        const published = fresh.some((t: any) => t.origin.kind === "work_result" &&
          (!t.origin.review || t.origin.review.phase === "publish") && t.state === "completed")
        if (!busy.length && (!produced || published)) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error("Real-model case did not settle within six minutes")
    }
    const turn = async (
      bot: any,
      test: Pick<Case, "id" | "label" | "preferred" | "naturalSkill">,
      message: string,
      selection?: ReturnType<typeof slashSkillSelection>
    ) => {
      const before = await snapshot(bot)
      const oldIds = new Set(before.messages.map((m: any) => m.id))
      const oldTasks = new Set(before.tasks.map((t: any) => t.id))
      activeTurn = { id: test.id, label: test.label, preferred: test.preferred, message, selectedSkill: selection?.name }
      await archive.checkpoint(report(), `case:${test.id}`)
      let start = Date.now()
      let task
      if (selection) {
        // Exercise the picker itself so the Host receives the trusted selection alongside the text.
        if (!(await page.locator(".bots-workspace").isVisible()))
          await page.getByText("Bots", { exact: true }).first().click()
        await page.getByText(bot.name, { exact: true }).first().click()
        const chat = page.locator(`[data-chat-thread-id="${bot.threadId}"]`)
        const editor = chat.locator('[data-bot-composer] textarea, [data-bot-composer] [role="textbox"][contenteditable="true"]').last()
        await editor.fill("/" + selection.name)
        await chat.getByRole("listbox").getByText(selection.name, { exact: true }).click()
        await editor.fill(message)
        start = Date.now()
        await chat.locator('button[type="submit"]').last().click()
        await waitForBotAppState(page, async ({ botId, text, start }) =>
          (await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
            t.botId === botId && t.origin.kind === "user" && t.createdAt >= start && t.message === text
          ), { botId: bot.id, text: message, start }, { timeout: 30000 })
        task = (await snapshot(bot)).tasks.find((t: any) =>
          !oldTasks.has(t.id) && t.threadId === bot.threadId && t.origin.kind === "user" && t.message === message)
        assert.ok(task, "the main Bot must accept the skill draft from the composer")
        assert.equal(task.origin.explicitSkill?.name, selection.name)
        assert.equal(await realpath(task.origin.explicitSkill.path), await realpath(selection.path))
      } else {
        task = await send(bot.id, message)
      }
      let responsiveness: { overlapObserved: boolean; reply?: string; seconds?: number; exactFormat: boolean } | undefined
      if (["browser-lookup", "event-plan", "background-plan", "reconcile", "code-fix", "reconciliation-cli"].includes(test.id) ||
          (test.id === "slash-skill-natural" && process.env.BOT_ROUTING_PROBE_RESPONSIVENESS === "1")) {
        await waitForBotAppState(
          page,
          async (taskId) => {
            const api = (window as any).api
            return !(await api.bots.snapshot()).tasks.some(
              (t: any) => t.id === taskId && ["queued", "running", "waiting_user"].includes(t.state)
            )
          },
          task.id,
          { timeout: 90000 }
        )
        const during = await snapshot(bot)
        console.log(JSON.stringify({ case: test.id, stage: "main-idle",
          seconds: +((Date.now() - start) / 1000).toFixed(1),
          workCreated: during.works.length > before.works.length }))
        if (during.works.length) {
          const questionStart = Date.now()
          const question = await send(
            bot.id,
            "另外一个小问题：2+3等于几？只回复数字，刚才的工作照常进行。"
          )
          await waitForBotAppState(
            page,
            async (id) =>
              (await (window as any).api.bots.snapshot()).tasks.some(
                (t: any) => t.id === id && ["completed", "failed"].includes(t.state)
              ),
            question.id,
            { timeout: 90000 }
          )
          const concurrent = await snapshot(bot)
          const answer = concurrent.messages
            .filter((m: any) => m.role === "assistant" && typeof m.content === "string")
            .at(-1)?.content
          responsiveness = {
            overlapObserved: concurrent.tasks.some(
              (t: any) => t.workId && ["queued", "running", "waiting_user"].includes(t.state)
            ),
            reply: answer,
            exactFormat: answer?.trim() === "5",
            seconds: +((Date.now() - questionStart) / 1000).toFixed(1)
          }
          // Record extra prose separately; do not cancel a real worker merely
          // because a correct short answer also mentions that work's status.
          assert.match(answer?.trim() ?? "", /^5(?:\s|[。.!！]|$)/, "main chat must answer the unrelated question")
        }
      }
      await settle(bot.id, false, oldTasks)
      if (test.id === "named-schedule") {
        const saved = await snapshot(bot)
        assert.equal(saved.schedules.length, 1, "a timed skill must first save the routine")
        await waitForBotAppState(page, async id => (await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
          t.botId === id && t.origin.kind === "schedule" && t.workId), bot.id, { timeout: 90000 })
        await settle(bot.id, false, oldTasks)
      }
      if (test.id === "background-command") {
        const launched = await snapshot(bot)
        const acceptedBackground =
          launched.backgroundActive ||
          launched.tasks.some(
            (t: any) =>
              t.createdAt >= start &&
              t.origin.kind === "notification" &&
              t.origin.notificationKind === "command"
          ) ||
          launched.messages
            .filter((m: any) => !oldIds.has(m.id))
            .some((m: any) =>
              (m.tool_calls ?? []).some(
                (c: any) => c.name === "execute" && c.args?.run_in_background === true
              )
            )
        if (acceptedBackground) {
          // An idle foreground turn does not mean its background command ended.
          // Keep the App alive until the actual completion reaches this Bot.
          await waitForBotAppState(
            page,
            async ({ botId, start }) =>
              (await (window as any).api.bots.snapshot()).tasks.some(
                (t: any) =>
                  t.botId === botId &&
                  t.createdAt >= start &&
                  t.origin.kind === "notification" &&
                  t.state === "completed"
              ),
            { botId: bot.id, start },
            { timeout: 90000 }
          )
          await settle(bot.id)
        }
      }
      const data = await snapshot(bot)
      const messages = data.messages.filter((m: any) => !oldIds.has(m.id))
      const tasks = data.tasks.filter((t: any) => !oldTasks.has(t.id))
      // Foreground dispatch, the parallel user question and result review share one thread.
      const otherRequests = new Set(tasks.filter((t: any) => t.threadId === task.threadId && t.id !== task.id).map((t: any) => t.requestId))
      const startIndex = messages.findIndex((m: any) => m.id === task.requestId)
      assert.ok(startIndex >= 0, "the tested user request must appear in main history")
      const nextIndex = messages.findIndex((m: any, i: number) => i > startIndex && otherRequests.has(m.id))
      const mainMessages = messages.slice(startIndex, nextIndex < 0 ? undefined : nextIndex)
      const calls = mainMessages.flatMap((m: any) => m.tool_calls ?? [])
      const tools = calls.map((c: any) => c.name)
      const lastBatch = mainMessages.findLast((m: any) => m.role === "assistant" && m.tool_calls?.length)?.tool_calls
      const receipts = new Map(mainMessages.filter((m: any) => m.role === "tool").map((m: any) => [m.tool_call_id, m]))
      const dispatchReceiptIndex = mainMessages.findIndex((m: any) => {
        const call = m.role === "tool" && calls.find((c: any) => c.id === m.tool_call_id)
        return call && acceptedBotDispatch(call.name, call.args, m)
      })
      const resultTasks = tasks.filter((t: any) => t.origin.kind === "work_result" && t.state === "completed")
      const publications = resultTasks.filter((t: any) => !t.origin.review || t.origin.review.phase === "publish")
      const allTools = [
        ...messages.flatMap((m: any) => m.tool_calls ?? []),
        ...data.workMessages.flatMap((ms: any[]) => ms.flatMap((m) => m.tool_calls ?? []))
      ]
      const background =
        calls.some((c: any) => c.name === "execute" && c.args?.run_in_background === true) ||
        tasks.some(
          (t: any) => t.origin.kind === "notification" && t.origin.notificationKind === "command"
        )
      const actual: Route =
        data.works.length > before.works.length
          ? "independent"
          : tools.includes("bot_work_send") || tools.includes("bot_skill_dispatch")
            ? "continue"
            : background
              ? "background"
              : "inline"
      const mainTask = data.tasks.find((t: any) => t.id === task.id)
      const mainRequests = wire.communicationRequests.filter(r => r.at >= start && r.user.includes(message))
      const result = {
        ...test,
        actual,
        followsPreference: actual === test.preferred,
        seconds: +((Date.now() - start) / 1000).toFixed(1),
        // Whole-case completion includes worker/report turns; record foreground
        // occupancy separately so it is not presented as dispatch latency.
        mainSeconds: mainTask
          ? +((mainTask.updatedAt - mainTask.createdAt) / 1000).toFixed(1)
          : undefined,
        mainModelRequests: mainRequests.length || null,
        finishesDispatchBatch: Boolean(lastBatch?.every((c: any) => !hasOutstandingBotRequest(c.args ?? {}, message) &&
          acceptedBotDispatch(c.name, c.args, receipts.get(c.id)))),
        mainToolChoices: mainRequests.map(r => r.choice),
        selectedSkill: selection?.name,
        dispatchSeconds: data.works.length && !before.works.length
          ? +((data.works[0].createdAt - start) / 1000).toFixed(1) : undefined,
        budgetHandoff: mainMessages.some(
          (m: any) =>
            m.role === "tool" &&
            typeof m.content === "string" &&
            (m.content.startsWith("Foreground execution budget reached.") || m.content.includes('"kind":"bot-foreground-continuation"'))
        ),
        message,
        tools: [...new Set(allTools.map((c: any) => c.name))],
        mainTools: tools,
        ...(["revision", "reopen"].includes(test.id) || test.id.startsWith("ops-log-") || test.id.startsWith("slash-skill") || test.naturalSkill ? {
          mainToolCalls: calls.map((call: any) => ({ name: call.name, args: call.args }))
        } : {}),
        ...(test.id.startsWith("slash-skill") || test.naturalSkill || test.id.startsWith("ops-log-") || test.id === "separate-answer" ? {
          mainAcknowledgements: mainMessages
            .filter((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())
            .map((m: any) => ({ text: m.content, afterDispatch: dispatchReceiptIndex >= 0 && dispatchReceiptIndex < mainMessages.indexOf(m) })),
          workToolCalls: data.workMessages.map((ms: any[], index: number) => ({
            threadId: data.works[index].threadId,
            calls: ms.flatMap((m: any) => m.tool_calls ?? [])
              .map((call: any) => ({ name: call.name, args: call.args }))
          }))
        } : {}),
        toolErrors: mainMessages
          .filter((m: any) => m.role === "tool" && (m.is_error || m.status === "error"))
          .map((m: any) => ({ tool: m.name, content: m.content })),
        reply: messages
          .filter((m: any) => m.role === "assistant" && typeof m.content === "string")
          .map((m: any) => m.content)
          .join("\n"),
        workIds: data.works.map((w: any) => w.id),
        workspaces: data.works.map((w: any) => w.workspace),
        states: tasks.map((t: any) => ({
          kind: t.origin.kind,
          reviewPhase: t.origin.review?.phase,
          state: t.state,
          workId: t.workId,
          error: t.error
        })),
        confirmCount: resultTasks.filter((t: any) => t.origin.review?.phase === "confirm").length,
        reviewCount: resultTasks.filter((t: any) => t.origin.review?.phase === "review").length,
        reportCount: publications.length,
        reviewedFixtureFiles: [...(reviewedFixtureFiles.get(test.id) ?? [])],
        ...(deliveryInputs.has(test.id) ? { deliveryInput: deliveryInputs.get(test.id) } : {}),
        backgroundReportCount: tasks.filter(
          (t: any) => t.origin.kind === "notification" && t.state === "completed"
        ).length,
        returnedPrdSha256: undefined as string | undefined,
        responsiveness,
        error: undefined as string | undefined,
        validation: "observed"
      }
      results.push(result)
      activeTurn = undefined
      await save()
      console.log(
        JSON.stringify({
          case: test.id,
          actual,
          preferred: test.preferred,
          seconds: result.seconds,
          mainSeconds: result.mainSeconds,
          dispatchSeconds: result.dispatchSeconds,
          mainModelRequests: result.mainModelRequests,
          finishesDispatchBatch: result.finishesDispatchBatch,
          budgetHandoff: result.budgetHandoff,
          tools
        })
      )
      assert.equal(
        data.tasks.find((t: any) => t.id === task.id)?.state,
        "completed",
        "main request must finish"
      )
      assert.ok(
        !tasks.some((t: any) => ["failed", "interrupted"].includes(t.state)),
        "execution must not fail silently"
      )
      if (actual === "independent" || actual === "continue") {
        assert.ok(result.reportCount > 0, "task result must return to parent")
        assert.ok(result.reviewCount > 0, "the originating Bot must compose the final reply")
        for (const publication of publications.filter((t: any) => t.origin.review))
          assert.ok(messages.some((m: any) => m.role === "assistant" && typeof m.content === "string" &&
            m.content.includes(`#bot-history/${publication.origin.workId}/`)), "published result must link to its own task")
        assert.ok(result.reply.trim(), "result notification must contain readable text")
        assert.doesNotMatch(
          result.reply,
          /DSML|<tool_call>/,
          "result must not expose attempted tool calls"
        )
      }
      if (test.naturalSkill && data.works.length) {
        const link = [...result.reply.matchAll(/\[prd\.md\]\((#bot-history\/[^)\s]+)\)/gi)].at(-1)?.[1]
        const attachment = link && parseBotWorkAttachmentHref(link)
        assert.ok(attachment, "the parent reply must include a retained PRD attachment")
        const { callId, fileIndex, ...history } = attachment
        const filePath = await page.evaluate(async ({ botId, history, callId, fileIndex }) => {
          const api = (window as any).api.bots
          const target = await api.works.resolveSource(botId, history)
          const file = await api.authorizeDeliveredFile({ threadId: target.threadId, assistantMessageId: target.messageId, callId, fileIndex })
          return file.filePath
        }, { botId: bot.id, history, callId, fileIndex })
        result.returnedPrdSha256 = experimentSha256(await readFile(filePath))
      }
      return { result, data }
    }
    for (const test of selected) {
      const firstResultIndex = results.length
      const directory = join(root, test.id === "ops-log-colleague" ? "billing-service-source" : test.id === "ops-log-triage" ? "order-service-source" : test.id)
      await mkdir(directory)
      for (const [name, text] of Object.entries(test.files ?? {}))
        await writeFile(join(directory, name), text)
      const bot = await page.evaluate(
        async ({ name, instructions }) =>
          (window as any).api.bots.create({
            name, instructions,
            color: "#168bea",
            modelRef: null
          }),
        { name: "路由验收 · " + test.label, instructions: test.instructions ?? "用中文协助用户完成日常工作，按要求交付结果。" }
      )
      // Opening a Bot starts its introduction. Settle that fixture setup before measuring the first skill submission.
      if (test.skill || test.naturalSkill || test.id.startsWith("ops-log-")) await page.evaluate(id => (window as any).api.bots.open(id), bot.id)
      await settle(bot.id, true)
      try {
        const { result, data } = await turn(bot, test, test.message(directory), test.skill?.(directory))
        await archive.checkpoint(report(), `verify:${test.id}`)
        await test.verify?.(directory, result, data)
        result.validation = "passed"
        await save()
        if (test.id === "library-brief") {
          const next = await turn(bot, { id: "named-revision", label: "文字点名修改原 PRD", preferred: "continue", naturalSkill: true },
            `继续刚才那份 PRD，用 ${prdFixtureSkillName} 技能把借期改成21天，校验后把更新的 prd.md 发给我。`)
          await verifyNaturalPrd(directory, next.result, next.data)
          assert.deepEqual(next.result.workIds, [data.works[0].id])
          next.result.validation = "passed"
          await save()
        }
        if (test.id === "slash-skill-natural" && process.env.BOT_ROUTING_PROBE_RESPONSIVENESS === "1") {
          assert.equal(result.responsiveness?.overlapObserved, true, "the worker must still be running while the main chat answers")
          if (!(await page.locator(".bots-workspace").isVisible()))
            await page.getByText("Bots", { exact: true }).first().click()
          await page.getByText(bot.name, { exact: true }).first().click()
          await page.locator(".bot-work-row").filter({ hasText: data.works[0].title }).first().waitFor()
          await page.locator(`[data-chat-thread-id="${bot.threadId}"]`)
            .getByText(result.mainAcknowledgements[0].text, { exact: true }).waitFor()
          await page.screenshot({ path: join(archive.directory, "slash-skill-main-return.png") })
          await page.getByRole("button", { name: "进入任务：" + data.works[0].title, exact: true }).first().click()
          await page.locator(`[data-chat-thread-id="${data.works[0].threadId}"]`).waitFor()
          await page.locator(`[data-chat-thread-id="${data.works[0].threadId}"]`)
            .getByText("prd.md", { exact: true }).first().waitFor()
          await page.screenshot({ path: join(archive.directory, "slash-skill-task.png") })
        }
        if (test.id === "slash-skill") {
          const revision = await turn(bot,
            { id: "slash-skill-revision", label: "不再选择技能，继续原任务修改并回传", preferred: "continue" },
            "刚才那份 PRD 的借期改为21天，其他规则不变。继续原任务，更新 prd.md 并按原技能校验后重新交给我。")
          await verifySlashSkillRevision(directory, revision.result, data.works[0].id)
          revision.result.validation = "passed"
          await save()
          const current = revision.data.works[0]
          await page.evaluate(async (input) => (window as any).api.bots.works.lifecycle(input), {
            botId: bot.id, workId: current.id, expectedVersion: current.version,
            operationId: randomUUID(), action: "complete"
          })
          const reselection = await turn(bot,
            { id: "slash-skill-reselect", label: "再次选择技能，恢复已完成的原任务而非新建", preferred: "continue" },
            slashSkillRevisionRequest, slashSkillSelection(directory))
          await verifySlashSkillRevision(directory, reselection.result, data.works[0].id, true)
          assert.equal(reselection.result.mainModelRequests, 1)
          assert.deepEqual(reselection.result.mainTools, ["bot_skill_dispatch"])
          assert.equal(reselection.data.works[0].threadId, data.works[0].threadId)
          reselection.result.validation = "passed"
          await save()
        }
        if (["event-plan", "background-plan"].includes(test.id) && data.works.length > 0) {
          const deliveredIds = new Set(result.states.filter((state: any) =>
            state.kind === "work" && state.state === "completed").map((state: any) => state.workId))
          const delivered = data.works.filter((item: any) => deliveredIds.has(item.id))
          assert.equal(delivered.length, 1, "identify the original plan's producer before continuing")
          const [work] = delivered
          const initialIds = result.workIds.slice().sort()
          assert.equal(work.workspace.path, await realpath(directory))
          assert.equal(work.state, "active", "reply is not business completion")
          const follow = await turn(
            bot,
            { id: "revision", label: "修改既有方案", preferred: "continue" },
            "刚才的读书会改成下午四点，仍是90分钟，请更新原来的 plan.md 并交给我。"
          )
          assert.equal(
            follow.result.actual,
            "continue",
            "revision must execute in the existing task"
          )
          assert.deepEqual(follow.result.workIds.slice().sort(), initialIds)
          assertRevisionDispatch(follow.result, work.id)
          assert.match(
            await readFile(join(directory, "plan.md"), "utf8"),
            /16[:：]00|四点|下午\s*4/
          )
          follow.result.validation = "passed"
          await save()
          const status = await turn(
            bot,
            { id: "status", label: "查进度不重启执行", preferred: "inline" },
            "这份方案现在还在运行吗？只查看实际状态告诉我，不用继续改。"
          )
          assert.deepEqual(status.result.workIds.slice().sort(), initialIds)
          assert.ok(
            !status.result.mainTools.some((t: string) =>
              ["bot_work_create", "bot_work_send", "bot_work_continue"].includes(t)
            )
          )
          status.result.validation = "passed"
          await save()
          const current = status.data.works.find((item: any) => item.id === work.id)!
          const completed = await page.evaluate(async (input) => (window as any).api.bots.works.lifecycle(input), {
            botId: bot.id,
            workId: work.id,
            expectedVersion: current.version,
            operationId: randomUUID(),
            action: "complete"
          })
          const reopened = await turn(
            bot,
            { id: "reopen", label: "已完成任务再次修改", preferred: "continue" },
            "刚才已完成的读书会方案还要改一下：改成下午五点，更新同一份 plan.md，其他条件不变。"
          )
          assert.equal(
            reopened.result.actual,
            "continue",
            "reopening must send work to the same task"
          )
          assert.deepEqual(reopened.result.workIds.slice().sort(), initialIds)
          assertRevisionDispatch(reopened.result, work.id, completed.version)
          const resumedWork = reopened.data.works.find((item: any) => item.id === work.id)!
          assert.equal(resumedWork.threadId, work.threadId)
          assert.equal(resumedWork.workspace.path, work.workspace.path)
          assert.equal(resumedWork.state, "active")
          assert.match(
            await readFile(join(directory, "plan.md"), "utf8"),
            /17[:：]00|五点|下午\s*5/
          )
          reopened.result.validation = "passed"
          await save()
          await archive.checkpoint(report(), `screenshots:${test.id}`)
          // The preceding scenario may already have opened the Bot workspace.
          // Its mode switch is no longer rendered there; do not wait for it again.
          if (!(await page.locator(".bots-workspace").isVisible()))
            await page.getByText("Bots", { exact: true }).first().click()
          await page.getByText(bot.name, { exact: true }).first().click()
          await page.locator(".bot-work-row").filter({ hasText: work.title }).first().waitFor()
          await page.screenshot({ path: join(archive.directory, `${test.id}-task-return.png`) })
          await page.getByRole("button", { name: "进入任务：" + work.title, exact: true }).first().click()
          await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
          await page
            .locator(`[data-chat-thread-id="${work.threadId}"]`)
            .getByText(/17[:：]00|五点/)
            .first()
            .waitFor()
          await page.screenshot({ path: join(archive.directory, `${test.id}-task-revision.png`) })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const last = results.at(-1)
        if (activeTurn) {
          results.push({ ...activeTurn, error: message, validation: "failed" })
          activeTurn = undefined
        } else if (last && results.length > firstResultIndex) {
          last.error = message
          last.validation = "failed"
        } else results.push({ id: test.id, label: test.label, error: message, validation: "failed" })
        await save()
        console.error("FAIL", test.id, message.slice(0, 180))
        // Retain synthetic artifacts for diagnosing actual execution failures;
        // never copy the profile, credentials or model configuration.
        await cp(directory, join(out, "artifacts", "failed", test.id), { recursive: true })
        // A blocked turn must not keep consuming resources while other cases run.
        for (const task of (await snapshot(bot)).tasks.filter((t: any) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        ))
          await page
            .evaluate(async (id) => (window as any).api.bots.cancel(id), task.id)
            .catch(() => {})
        if (providerPaymentRequired) {
          await archive.checkpoint(report(), "provider:payment-required")
          throw new Error("Model service returned HTTP 402. Remaining cases were not run.")
        }
      }
      await save()
    }
    await archive.checkpoint(report(), "suite:request-contracts")
    assert.equal(wire.workerCreate, 0, "workers must not be offered recursive creation")
    assert.ok(wire.guided > 0, "actual main model request must include routing guidance")
    assert.equal(wire.mainPlanner, 0, "communication turns must not inherit the execution planner")
    assert.equal(wire.mainBrowserTools, 0, "communication turns must not be offered browser tools")
    if (results.some(r => r.reviewCount > 0))
      assert.ok(wire.reviewRequests.length > 0, "capture the real result-review request")
    const reviewTools = new Set(["bot_work_result_read", "bot_work_result_select_files", "bot_work_result_keep_service", "bot_work_result_continue"])
    for (const offered of wire.reviewRequests)
      assert.ok([...reviewTools].every(name => offered.includes(name)), "the stable main catalog must contain every scoped review tool")
    for (const check of wire.reportPrefixChecks) {
      assert.ok(check.systemUnchanged, "result reporting must retain the main Bot system prefix")
      assert.ok(check.toolsUnchanged, "result reporting must retain the main Bot tool schemas")
      if (check.role === "report") assert.equal(check.toolChoice, "none", "pure reporting must disable tool execution")
      if (!check.privatePreview) assert.ok(check.reusedHistoryMessages > 0, "results on the parent thread must retain previous conversation messages")
    }
    assert.ok(!results.some((result) => result.error), "case failures; inspect JSON report")
  } finally {
    await save()
    console.log("Routing evaluation report:", reportPath)
    await app?.close().catch(() => {})
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}
async function runRecorded() {
  const archive = await createBotExperimentArchive({
    repository: resolve("."),
    selectedCases: process.env.BOT_ROUTING_CASE?.split(",") ?? cases.map((c) => c.id)
  })
  console.log("Persistent experiment record:", join(archive.directory, "record.json"))
  try {
    await main(archive)
    await archive.finish("passed")
  } catch (error) {
    await archive.finish("failed", error)
    throw error
  }
}
runRecorded().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
