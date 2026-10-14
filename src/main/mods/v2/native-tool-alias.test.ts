import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())) })
async function session(body: string, host: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const s = new FunctionSession([{name:"alias",root:"/alias",tier:"user",guest,
    capabilities:[...SESSION_CAPABILITIES]}], {workspace:"/project",threadId:"thread",
    assertLive:()=>undefined,publish:async v=>v,...host})
  sessions.push(s)
  return s
}

it("runs official and legacy literal hooks with coherent event/next identities", async () => {
  const s = await session(`
    on("tool.call",{tool:"Bash"},($,e,next)=>{
      if(e.tool!=="Bash")throw Error("official identity");return next({...e,command:e.command.trim()})
    });
    on("tool.call",{tool:"execute"},($,e,next)=>{
      if(e.tool!=="execute")throw Error("legacy identity");return next({...e,command:e.command+" legacy"})
    });`)
  const core = vi.fn(async (input: ModObject) => {
    void input
    return {result:"ok",ref:7,isError:true as const}
  })
  expect(await s.interceptTool({tool:"execute",command:"  echo ok  ",tool_use_id:"host",agentId:"worker"},undefined,core))
    .toEqual({result:"ok",ref:7,isError:true})
  expect(core.mock.calls[0][0]).toEqual({tool:"execute",command:"echo ok legacy",tool_use_id:"host",agentId:"worker"})
  expect(core).toHaveBeenCalledTimes(1)
})

it("preserves Read line origin across a legacy literal recovery and next", async () => {
  const s = await session(`on("tool.call",{tool:"read_file"},()=>{throw Error("recover")})
    .catch(($,e,next)=>{if(e.tool!=="read_file"||e.offset!==0)throw Error("dialect");return next(e)});`)
  const core = vi.fn(async (input: ModObject) => {
    void input
    return {result:"line"}
  })
  await s.interceptTool({tool:"read_file",file_path:"a",offset:0,tool_use_id:"read"},undefined,core)
  expect(core.mock.calls[0][0]).toMatchObject({tool:"read_file",offset:0})
})

it("maps SDK list/call/check through native permission owners and keeps deny final", async () => {
  const callTool = vi.fn(async (plugin: FunctionPlugin, input: ModObject) => {
    void plugin
    void input
    return {deny:"host denied"}
  })
  const checkTool = vi.fn(async (plugin: FunctionPlugin, input: ModObject) => {
    void plugin
    void input
    return {decision:"deny" as const,reason:"host denied"}
  })
  const s = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"Probe"});return next(e)});
    on("command.run",async($)=>({text:JSON.stringify({list:await $.tool.list(),
      check:await $.tool.check({tool:"Read",input:{file_path:"a",offset:1}}),
      call:await $.tool.call({tool:"Bash",command:"echo ok"})})}));
    on("tool.check",{tool:"Read"},()=>({decision:"allow"}));`, {
    callTool,checkTool,listTools:async()=>[{name:"read_file",description:"Read",mcp:false},
      {name:"execute",description:"Run",mcp:false},{name:"glob",description:"Glob",mcp:false}]
  })
  const result = JSON.parse(String((await s.run("probe","")).text))
  expect(result.list.map((t: {name:string})=>t.name)).toEqual(["Read","Bash","glob"])
  expect(result.check.decision).toBe("deny")
  expect(result.call).toEqual({deny:"host denied"})
  expect(checkTool.mock.calls[0][1]).toMatchObject({tool:"read_file",input:{file_path:"a",offset:0}})
  expect(callTool.mock.calls[0][1]).toMatchObject({tool:"execute",command:"echo ok"})
})

it("does not allow a hook to switch native tool or host identity", async () => {
  const s = await session('on("tool.call",{tool:"Bash"},($,e,next)=>next({...e,tool:"Edit",tool_use_id:"forged",agentId:"forged"}));')
  const core = vi.fn(async (input: ModObject) => {
    void input
    return {deny:"native permission denied"}
  })
  const original = {tool:"execute",command:"echo",tool_use_id:"host",agentId:"worker"}
  // Invalid optional hooks are skipped by the existing dispatcher. The original native
  // permission owner still sees exactly one unchanged request; the forged tool never runs.
  expect(await s.interceptTool(original,undefined,core)).toEqual({deny:"native permission denied"})
  expect(core).toHaveBeenCalledTimes(1)
  expect(core.mock.calls[0][0]).toEqual(original)
})


it("preserves legacy array/regex matchers with whole-event matching and public precedence", async () => {
  const s = await session(`
    on("tool.call",{tool:["read_file","execute"],offset:0},($,e,next)=>{
      if(e.tool!=="read_file"||e.offset!==0)throw Error("array dialect");
      return next({...e,limit:2})
    });
    on("tool.call",{tool:/^read_file$/,offset:0},($,e,next)=>{
      if(e.tool!=="read_file")throw Error("regex dialect");return next({...e,limit:e.limit+1})
    });
    on("tool.call",{tool:/^(Read|read_file)$/},($,e,next)=>{
      if(e.tool!=="Read"||e.offset!==1)throw Error("public precedence");
      return next({...e,limit:e.limit+1})
    });`)
  const core=vi.fn(async(input:ModObject)=>{
    void input
    return {result:"ok"}
  })
  await s.interceptTool({tool:"read_file",file_path:"a",offset:0,tool_use_id:"read"},undefined,core)
  expect(core).toHaveBeenCalledTimes(1)
  expect(core.mock.calls[0][0]).toMatchObject({tool:"read_file",offset:0,limit:4})
})
