import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const name = "slash-prd-fixture"
const skillDirectory = (root: string) => join(root, "profile", "skills", name)

/** An installed, disposable skill with real lifecycle hooks and an executable resource. */
export async function installSlashSkillFixture(root: string) {
  const directory = skillDirectory(root)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "SKILL.md"), `---
name: ${name}
description: 把虚构需求与约束整理为 PRD，并执行本地校验、交付文件。
---
读取用户工作目录中的需求.md、约束.md、现有接口.md。完成以下步骤：
1. 编写 prd.md，含需求范围、业务规则、验收标准三个章节。忠实保留输入数字与约束。
2. 在文档首行使用 # PRD，紧接一行标记 SKILL_PRD_OK。
3. 在任务工作目录执行本技能目录下的 verify.mjs（使用绝对脚本路径），它会校验产物并写入 .skill-receipt.json。实际执行，不得自己编写或修改回执。
4. 使用 bot_deliver_files 交付 prd.md，并用中文概述结果。
后续修改沿用已有 prd.md，修改后重新运行 verify.mjs 再交付。
`)
  await writeFile(join(directory, "verify.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const text=readFileSync('prd.md','utf8');
if(!text.startsWith('# PRD')||!text.includes('SKILL_PRD_OK'))throw new Error('Skill document contract not applied');
writeFileSync('.skill-receipt.json',JSON.stringify({cwd:process.cwd(),sha256:createHash('sha256').update(text).digest('hex'),verified:true}));
console.log('SKILL_VERIFIED');
`)
  const hookPath = join(directory, "lifecycle.mjs")
  await writeFile(hookPath, `import {appendFileSync} from 'node:fs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const p=JSON.parse(raw);
appendFileSync(${JSON.stringify(join(root, "skill-lifecycle.jsonl"))},JSON.stringify({event:p.hook_event_name,sessionId:p.session_id,trigger:p.skill_trigger_tool_name})+'\\n');
`)
  const command = "node '" + hookPath.replaceAll("'", "'\\''") + "'"
  await writeFile(join(directory, "hooks.json"), JSON.stringify(
    ["PreSkillUse", "PostSkillUse"].map(event => ({ id: event, event, command, enabled: true }))
  ))
}

export function slashSkillSelection(directory: string) {
  return { name, path: join(skillDirectory(dirname(directory)), "SKILL.md") }
}

export function slashSkillRequest(directory: string, explicitTask = true) {
  return `请使用我选择的技能，${explicitTask ? "创建独立任务，" : ""}工作目录 ${directory}。综合需求.md、约束.md、现有接口.md生成 prd.md，执行技能的校验并把文件交给我。资料都是虚构的，不联网，也不发送外部消息。`
}

export const slashSkillRevisionRequest = "继续刚才那份 PRD，借期改为28天，其他规则不变。按我选择的技能更新原文件、校验并交给我。"

export async function verifySlashSkillResult(directory: string, result: any, data: any, requireIndependent = true) {
  if (requireIndependent)
    assert.equal(result.actual, "independent", "the explicit assignment must create a worker")
  assert.equal(result.actual, "independent", "a main-Bot slash selection deterministically dispatches")
  assert.deepEqual(result.mainTools, ["bot_skill_dispatch"], "no main skill/file read or shell before dispatch")
  assert.equal(result.mainModelRequests, 1, "no second main-model acknowledgement")
  assert.deepEqual(result.mainToolChoices, [{ type: "function", function: { name: "bot_skill_dispatch" } }])
  assert.equal(result.mainAcknowledgements.length, 1)
  assert.equal(result.mainAcknowledgements[0].text, "已新建任务，我会按所选技能处理，结果发回这里。")
  assert.equal(result.mainAcknowledgements[0].afterDispatch, true)
  assert.equal(result.budgetHandoff, false)
  assert.equal(data.works.length, result.actual === "independent" ? 1 : 0)
  const work = data.works[0]
  if (work) assert.equal(await realpath(work.workspace.path), await realpath(directory))
  const text = await readFile(join(directory, "prd.md"), "utf8")
  assert.match(text, /^# PRD/)
  assert.match(text, /SKILL_PRD_OK/)
  assert.match(text, /14/)
  assert.match(text, /3/)
  const receipt = JSON.parse(await readFile(join(directory, ".skill-receipt.json"), "utf8"))
  assert.equal(await realpath(receipt.cwd), await realpath(directory))
  assert.equal(receipt.verified, true)
  assert.equal(receipt.sha256, createHash("sha256").update(text).digest("hex"))
  const lifecycle = (await readFile(join(dirname(directory), "skill-lifecycle.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line))
  const executorThreadId = work?.threadId ?? data.tasks.find((task: any) => task.origin.kind === "user")?.threadId
  assert.ok(executorThreadId)
  assert.ok(!lifecycle.some(entry => data.tasks.some((task: any) => !task.workId && task.threadId === entry.sessionId)), "main dispatch and report must not activate the skill")
  const executorHooks = lifecycle.filter(entry => entry.sessionId === executorThreadId)
  result.skillRoutingObservation = {
    explicitTaskRequested: requireIndependent,
    mainCalls: result.mainToolCalls,
    workCalls: result.workToolCalls,
    lifecycle
  }
  assert.equal(executorHooks.filter(entry => entry.event === "PreSkillUse").length, 1,
    "executor startup and reading SKILL.md must share one activation")
  assert.equal(executorHooks.find(entry => entry.event === "PreSkillUse")?.trigger, "skill_select",
    "activation must be explicit, not an incidental model file read")
  assert.ok(executorHooks.some(entry => entry.event === "PostSkillUse"), "executor lifecycle must finish")
  assert.ok(result.tools.includes("bot_deliver_files"), "executor must actually deliver the artifact")
  if (work) assert.ok(result.reportCount > 0, "worker result must reach the parent Bot")
  result.skillValidation = { executorExplicitActivation: true, executorHooks,
    scriptVerified: true, artifact: "prd.md", sha256: receipt.sha256,
    deliveryVerified: true, resultReported: work ? result.reportCount > 0 : null }
}

export async function verifySlashSkillRevision(directory: string, result: any, workId: string, selectedAgain = false) {
  assert.equal(result.actual, "continue")
  assert.deepEqual(result.workIds, [workId])
  if (selectedAgain) {
    assert.equal(result.mainModelRequests, 1, "continuing a skill task needs no second acknowledgement call")
    assert.deepEqual(result.mainAcknowledgements.map((item: any) => item.text), ["我会在原任务中继续处理，结果发回这里。"])
    assert.equal(result.mainAcknowledgements[0].afterDispatch, true)
  }
  const text = await readFile(join(directory, "prd.md"), "utf8")
  assert.match(text, selectedAgain ? /28/ : /21/)
  assert.match(text, /SKILL_PRD_OK/)
  const receipt = JSON.parse(await readFile(join(directory, ".skill-receipt.json"), "utf8"))
  assert.equal(receipt.sha256, createHash("sha256").update(text).digest("hex"), "the skill's script must verify the updated artifact")
  assert.equal(await realpath(receipt.cwd), await realpath(directory))
  assert.ok(result.reportCount > 0)
  result.skillValidation = { selectedAgain, sameWork: true, sameWorkspace: true,
    scriptVerified: true, artifact: "prd.md", sha256: receipt.sha256, resultReported: true }
}
