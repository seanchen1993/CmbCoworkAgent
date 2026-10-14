import { expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("../manager",()=>({getModsManager:()=>({isEnabled:()=>false})}))
vi.mock("../../hooks/http-runner",()=>({executeHttpHook:mock.execute}))
vi.mock("../../storage",()=>({getHookLoggingConfig:()=>({diagnostic:false}),getUserInfo:()=>undefined}))
vi.mock("../../hooks/log-record",()=>({persistHookResultRecord:vi.fn()}))
vi.mock("../../services/event-reporter",()=>({trackEvent:vi.fn()}))
import {runHooks} from "../../hooks/runner"
import {readBuiltinPolicyDecisions,registerBuiltinPolicyScopeResolver} from "./policy-decisions"
it("observes the original Hook outcome without saving its arbitrary sensitive reason",async()=>{
 const scope={threadId:"thread",workspace:"workspace",incarnationKey:"original"}
 const close=registerBuiltinPolicyScopeResolver(()=>scope)
 try {
  mock.execute.mockResolvedValue({exitCode:0,stdout:"",stderr:"",blocked:true,decision:"block",reason:"sensitive-business-text"})
  const result=await runHooks([{id:"hook",event:"PreSkillUse",type:"http",url:"http://fixture.invalid",enabled:true,createdAt:"",updatedAt:"",hookSourceType:"plugin"}],"PreSkillUse",{sessionId:"thread",workspacePath:"workspace",skillName:"draft"})
  expect(result?.blocked).toBe(true)
  const view=readBuiltinPolicyDecisions(scope)
  expect(view.records[0]).toMatchObject({source:"hook",scope:"plugin",decision:"deny",ruleId:"HOOK_BLOCKED"})
  expect(JSON.stringify(view)).not.toContain("sensitive-business-text")
 }finally{close()}
})
