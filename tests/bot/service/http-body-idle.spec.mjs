import { test } from "node:test"
import assert from "node:assert/strict"
import { requireContainerBodyIdle } from "../../../deploy/dev/service/http-transport.mjs"
import { validateHttpResponse } from "../../../deploy/dev/service/http-client.mjs"

test("only the fixed createBot body-idle fixture admits bounded container empty 400",()=>{
  const valid=()=>({frames:[{status:400,headers:{"content-length":"0",connection:"close"},body:Buffer.alloc(0)}],elapsedMs:4130})
  assert.doesNotThrow(()=>requireContainerBodyIdle("incomplete-body-idle","createBot",valid()))
  for(const change of [r=>r.frames[0].status=408,r=>r.frames[0].status=200,r=>r.frames[0].headers["content-length"]="00",r=>delete r.frames[0].headers["content-length"],r=>r.frames[0].headers["transfer-encoding"]="",r=>r.frames[0].headers["transfer-encoding"]="chunked",r=>r.frames[0].headers.connection="keep-alive",r=>delete r.frames[0].headers.connection,r=>r.frames[0].body=Buffer.from("{}"),r=>r.frames=[],r=>r.frames.push(r.frames[0]),r=>r.elapsedMs=1199,r=>r.elapsedMs=4501]){
    const result=valid();change(result);assert.throws(()=>requireContainerBodyIdle("incomplete-body-idle","createBot",result),/C2_TRANSPORT_ASSERTION/)
  }
  assert.throws(()=>requireContainerBodyIdle("slow-drip-body-absolute","createBot",valid()),/C2_TRANSPORT_ASSERTION/)
  assert.throws(()=>requireContainerBodyIdle("incomplete-body-idle","getBot",valid()),/C2_TRANSPORT_ASSERTION/)
})
test("ordinary empty error bytes remain rejected for all six operations",()=>{
  for(const operation of ["createBot","getBot","createBotVersion","createGroup","getGroup","updateGroupMembers"])assert.throws(()=>validateHttpResponse(operation,400,Buffer.alloc(0)),/C2_RESPONSE_SCHEMA/)
})
