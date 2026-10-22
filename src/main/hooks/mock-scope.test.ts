import {describe,expect,it,vi} from "vitest"
const storage=vi.hoisted(()=>({getEnabledHooks:vi.fn(()=>[]),getEnabledPluginHookMetadata:vi.fn(()=>[]),getEnabledSkillHookMetadata:vi.fn(()=>[]),getEnabledPluginSkillSourceMetadata:vi.fn(()=>[])}))
vi.mock("../storage",()=>storage)
import {createHookScope,createInheritedHookScope,filterScopedHooks,resolveEnabledHooksForRun} from "./scope"
import type {HookConfig} from "./types"
describe("mock hook scope",()=>{
  it("suppresses every lifecycle phase before storage and inherits only within the opted-in source",()=>{
    const hook={id:"owner",event:"SessionStart",type:"command",command:"echo private",enabled:true,createdAt:"",updatedAt:""} as HookConfig
    const disabled=createHookScope({disabled:true}), child=createInheritedHookScope(disabled)
    for(const event of ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionEnd"] as const){
      expect(resolveEnabledHooksForRun("/fixture",event,{},disabled)).toEqual([])
      expect(filterScopedHooks({baseHooks:[hook],pluginHooks:[],skillHooks:[]},{},child,undefined,event)).toEqual([])
    }
    expect(storage.getEnabledHooks).not.toHaveBeenCalled()
    const ordinary=createHookScope()
    expect(filterScopedHooks({baseHooks:[hook],pluginHooks:[],skillHooks:[]},{},ordinary,undefined,"SessionStart")).toEqual([hook])
    expect(createInheritedHookScope(ordinary).disabled).toBeUndefined()
  })
})
