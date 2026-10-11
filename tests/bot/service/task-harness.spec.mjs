import { test } from "node:test"
import assert from "node:assert/strict"
import { operations } from "../../../contracts/bot/v1/fixtures/positive.mjs"
import { validateHttpResponse } from "../../../deploy/dev/service/http-client.mjs"
import { taskSql } from "../../../deploy/dev/service/task-sql.mjs"
import { taskCheck,taskFailureCategory } from "../../../deploy/dev/service/task-check.mjs"

test("Task diagnostics expose fixed error codes, not arbitrary child or secret text",()=>{
  for(const code of["B02_ASSERTION","B1_JAVA_BOUNDARY","C2_IDENTITY_FILE"])assert.equal(taskFailureCategory(Error(code)),code)
  for(const message of["password=secret","SQL SELECT text","B1_FAILURE\nsecret",""])assert.equal(taskFailureCategory(Error(message)),"IO")
  assert.equal(taskFailureCategory(null),"IO")
})

test("four Task response baselines execute the original Ajv without expanding Run",()=>{
  for(const operation of["createTask","getTask","createTaskMessage","getEvents"]){
    const fixture=operations.find(x=>x.operationId===operation),response=fixture.responses.find(x=>x.status<300)
    assert.ok(validateHttpResponse(operation,response.status,Buffer.from(JSON.stringify(response.body))))
    assert.throws(()=>validateHttpResponse(operation,response.status,Buffer.from("{}")),/RESPONSE_SCHEMA/)
  }
  assert.throws(()=>validateHttpResponse("createRun",201,Buffer.from("{}")),/OPERATION_SELECTION/)
})
test("Task fixture SQL actions cannot select arbitrary queries or migrations",async()=>{
  for(const action of["repair","clean","drop","grant","SELECT 1","target-2"])
    await assert.rejects(taskSql(null,null,action),/B02_SQL_SELECTION/)
})
test("already-cancelled Task checks refuse work before any resource or secret read",async()=>{
  const controller=new AbortController();controller.abort()
  await assert.rejects(taskCheck(controller.signal),/B1_CANCELLED/)
  await assert.rejects(taskSql(null,null,"facts",{},controller.signal),/B1_CANCELLED/)
})
