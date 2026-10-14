/** Same-process bounded overhead comparison, excluding model/network/UI rendering latency. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { SkillPromptSnapshots } from "../src/main/agent/skill-lifecycle/prompt-snapshot"
import { describeModTools } from "../src/main/agent/mods-tool-descriptions"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../src/main/mods/v2/session"

async function main() {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let calls=0;
    on("tool.describe",($,e)=>({description:e.description+":"+(++calls)}));
    on("prompt.compose",async($,e,next)=>{
      const out=await next(e);
      return {sections:[...out.sections,{id:"perf:tail",text:"actual-hook",scope:"session"}]}
    });
  }}`)
  const session = new FunctionSession(
    [{ name: "perf", root: "/perf", tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: "/project",
      threadId: "perf",
      assertLive: () => undefined,
      publish: async (v) => v
    }
  )
  const tools = Array.from({ length: 128 }, (_, i) => ({
    name: `tool${i}`,
    description: `Description ${i}`,
    schema: { type: "object", properties: { path: { type: "string" } } }
  }))
  const report: Record<string, unknown> = {
    node: process.version,
    scope:
      "128 tool descriptors and 64KiB Skill, same process; excludes disk scanning/model/network/renderer",
    toolCount: tools.length
  }
  const measure = async (operation: () => Promise<unknown>) => {
    const started = performance.now()
    await operation()
    return performance.now() - started
  }
  try {
    await session.start()
    report.toolsWithoutHookMs = await measure(async () => structuredClone(tools))
    const describe = () =>
      describeModTools(
        tools,
        (input) => session.presentationEvent("tool.describe", input, new AbortController().signal),
        () => undefined
      )
    let first: typeof tools = []
    report.toolsColdHookMs = await measure(async () => {
      first = await describe()
    })
    const warm: number[] = []
    for (let i = 0; i < 5; i++)
      warm.push(await measure(async () => assert.deepEqual(await describe(), first)))
    report.toolsWarmHookMs = warm
    report.toolsWarmMedianMs = [...warm].sort((a, b) => a - b)[2]
    assert.equal(first[127].description, "Description 127:128")
    assert.equal(tools[127].description, "Description 127")
    const source = "A line of Skill content.\n".repeat(2800)
    let expansions = 0
    const snapshots = new SkillPromptSnapshots()
    const read = () =>
      snapshots.expand(
        "skill",
        source,
        async (text) => {
          expansions++
          return text
        },
        () => undefined
      )
    report.skillRawTenPagesMs = await measure(async () => {
      for (let i = 0; i < 10; i++)
        assert.equal(source.split("\n").slice(i * 100, i * 100 + 100).length, 100)
    })
    report.skillExpandedTenPagesMs = await measure(async () => {
      for (let i = 0; i < 10; i++)
        assert.equal((await read()).split("\n").slice(i * 100, i * 100 + 100).length, 100)
    })
    assert.equal(expansions, 1)
    report.skillExpansions = expansions
    const composed = { sections: [{ id: "system", text: source, scope: "session" }] }
    const composeTimes: number[] = []
    for (let i = 0; i < 5; i++) composeTimes.push(await measure(async () => {
      const result = await session.promptComposition("prompt.compose", {
        model: "perf", promptModel: "perf", tools: tools.map(tool => tool.name),
        surfaces: ["desktop"], outputStyle: null, traits: []
      }, new AbortController().signal, async () => composed)
      assert.equal((result.sections as Array<{ text: string }>)[1].text, "actual-hook")
    }))
    report.promptCompose64KiBMs = composeTimes
    report.promptComposeMedianMs = [...composeTimes].sort((a, b) => a - b)[2]
    const out = resolve("output/mods-integrated-performance")
    mkdirSync(out, { recursive: true })
    writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await session.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
