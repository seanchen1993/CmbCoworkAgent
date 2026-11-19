import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { NativeSqliteAdapter } from "../../../../../src/main/db/native-sqlite-adapter"
import { BotStore } from "../../../../../src/main/bots/store"
import { acceptedBotDispatch, botDispatchFeedback } from "../../../../../src/main/agent/bot-dispatch-feedback"
const input = "刚才的读书会改成下午四点，仍是90分钟，请更新原来的 plan.md 并交给我。"
const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
try {
  const store = new BotStore(db)
  const bot = store.create({ name: "测试 Bot", instructions: "", color: "#168bea", modelRef: null })
  const { work, task } = store.createWork({ botId: bot.id, operationId: "initial", title: "读书会", goal: "制定读书会方案" })
  store.transition(task.id, "running")
  store.settle(task.id, "completed", null, "方案已交付")
  const parent = store.enqueue({ botId: bot.id, requestId: "revision", message: input })
  store.transition(parent.id, "running")
  store.recordPreparedInput(parent.id, input)
  const args = { workId: work.id, message: "改到16:00，保持90分钟，更新并交付原 plan.md。" }
  const invoke = (callId: string, key: string) => store.sendWork({ taskId: parent.id, callId, key }, work.id, args.message)
  const first = invoke("call-1", "time-1600")
  const replay = invoke("call-2", "time-1600")
  const renamed = invoke("call-3", "time-1600-ack")
  assert.equal(first.id, replay.id)
  assert.notEqual(first.id, renamed.id)
  const content = JSON.stringify({ kind: "bot-work-receipt", operation: "bot_work_send", receipt: first })
  const run = (finish: true | undefined) => {
    const callArgs = { ...args, requestKey: "time-1600", ...(finish === true ? { finishTurn: true } : {}) }
    const assistant = new AIMessage({content:"我来调整这份方案。", tool_calls:[{ name:"bot_work_send", id:"call-1", args:callArgs }]})
    const tool = new ToolMessage({ name:"bot_work_send", tool_call_id:"call-1", status:"success", content })
    return { accepted: acceptedBotDispatch("bot_work_send",callArgs,tool), automaticEnd: !!botDispatchFeedback([new HumanMessage({id:"revision",content:input}),assistant,tool]) }
  }
  const omitted = run(undefined), flagged = run(true)
  assert.deepEqual(omitted,{accepted:true,automaticEnd:false})
  assert.deepEqual(flagged,{accepted:true,automaticEnd:true})
  console.log(JSON.stringify({kind:"controlled-store-and-turn-middleware; no LLM",sameUserSameTargetSameText:true, sameKeyNewCallReusesReceipt:first.id===replay.id, newKeyNewCallCreatesNewExecution:first.id!==renamed.id,acceptedFollowupCount:new Set([first.id,replay.id,renamed.id]).size, omittedFinishTurn:omitted, explicitFinishTurn:flagged},null,2))
} finally { db.close() }
