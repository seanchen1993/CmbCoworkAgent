import { describe,expect,it,vi } from "vitest"
import { createRuntimeToolAllowlistMiddleware } from "./runtime-tool-allowlist"
describe("trusted runtime tool ceiling",()=>{
  it("filters model-visible dynamic tools and rejects their invocation without touching the handler",async()=>{
    const middleware=createRuntimeToolAllowlistMiddleware(["bot_work_list"]) as any
    const model=vi.fn(v=>v),execute=vi.fn(()=>"executed")
    const request={tools:[{name:"read_file"},{name:"dynamic_private"},{name:"bot_work_list"},{description:"unnamed"}]}
    expect(middleware.wrapModelCall(request,model).tools).toEqual([{name:"bot_work_list"}])
    for(const name of ["read_file","dynamic_private",undefined]){
      const result=await middleware.wrapToolCall({toolCall:{name,id:"tool"}},execute)
      expect(result.status).toBe("error")
      expect(execute).not.toHaveBeenCalled()
    }
    expect(await middleware.wrapToolCall({toolCall:{name:"bot_work_list",id:"allowed"}},execute)).toBe("executed")
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
