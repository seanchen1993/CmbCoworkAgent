import {describe,expect,it} from "vitest"
import {assertBotMockThreadEntry,botMockRemotePolicy,botMockMetadataSafe} from "./mock-runtime-policy"
import type {AgentRunExecutionContext} from "../agent/agent-run-service"
describe("persistent mock runtime boundary",()=>{
  it("refuses generic invoke/resume/forged desktop authority but leaves ordinary beta unchanged",()=>{
    const meta={botMockBindingId:"binding"}
    expect(()=>assertBotMockThreadEntry({})).not.toThrow()
    expect(()=>assertBotMockThreadEntry(meta)).toThrow("绑定执行")
    const context={source:"bot",verifyResolvedThread:()=>{},remotePolicy:botMockRemotePolicy()} as unknown as AgentRunExecutionContext
    expect(()=>assertBotMockThreadEntry(meta,context)).not.toThrow()
    for(const override of [{source:"desktop"},{verifyResolvedThread:undefined},{remotePolicy:{...botMockRemotePolicy(),allowedToolNames:["read_file"]}},{remotePolicy:{...botMockRemotePolicy(),omitPromptExtensions:undefined}}])expect(()=>assertBotMockThreadEntry(meta,{...context,...override} as AgentRunExecutionContext)).toThrow()
    expect(botMockMetadataSafe({featureId:"private"})).toBe(false)
    expect(botMockMetadataSafe({pluginPromptInject:"private"})).toBe(false)
    expect(botMockMetadataSafe({harnessFeature:null,featureId:undefined})).toBe(true)
  })
})
