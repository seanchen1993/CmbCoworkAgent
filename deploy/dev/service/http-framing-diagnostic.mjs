import { isDeepStrictEqual } from "node:util"
import { createTestDatabase,startTestDatabase,cleanupTestDatabase,active } from "./test-database.mjs"
import { packagedDatabaseRuntime,closeDatabaseRuntime,javaDatabase } from "./database-java.mjs"
import { createHttpFixture,closeHttpFixture } from "./http-fixture.mjs"
import { httpPrincipals } from "./http-check.mjs"
import { startHttpJava,stopHttpChildren } from "./http-java.mjs"
import { httpWire } from "./http-transport.mjs"
import { httpSql,stopHttpSqlChildren } from "./http-sql.mjs"
import { httpDevProof,httpCapacity,httpAbsent } from "./http-proof.mjs"
import { httpCall,validateHttpResponse } from "./http-client.mjs"
import { assertHttpNoSecret } from "./http-java.mjs"
import { schemas } from "../../../tests/bot/schema-support.mjs"

const check=x=>{if(!x)throw Error("C2_DIAGNOSTIC_ASSERTION")},controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,180000);process.once("SIGTERM",cancel)
let runtime,entry,fixture,server,original,failed=false
try{
  if(process.argv.length!==2)throw Error("C2_ARGUMENTS")
  await httpAbsent("devclaw-bot-test-fef8bfd1815895ba");original=await httpDevProof();active(controller.signal);runtime=await packagedDatabaseRuntime();active(controller.signal);await httpCapacity(controller.signal);active(controller.signal)
  entry=await createTestDatabase();active(controller.signal);console.log(JSON.stringify({stage:"http-diagnostic-db",...await startTestDatabase(entry,controller.signal)}))
  const migration=await javaDatabase(runtime,entry,"migrate",{signal:controller.signal});check(migration.exitCode===0&&migration.proof.migrations===2)
  fixture=await createHttpFixture(httpPrincipals(),controller.signal);server=await startHttpJava(runtime,entry,fixture,"production",controller.signal);console.log(JSON.stringify({stage:"http-diagnostic-listener",pid:server.pid,port:server.port}))
  const before=await httpSql(runtime,entry,"facts",{},controller.signal)
  const result=await httpWire(server,x=>`POST /api/bot/v1/bots HTTP/1.1\r\nHost: 127.0.0.1:${x.port}\r\nAuthorization: Bearer ${x.token}\r\nX-DevClaw-Space: A\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n`,controller.signal)
  check(result.frames.length===1);const frame=result.frames[0];assertHttpNoSecret(server,frame.body)
  let strictUTF8=false,json=false,originalSchema=false,errorCode=null,value
  try{const text=new TextDecoder("utf-8",{fatal:true}).decode(frame.body);strictUTF8=true;try{value=JSON.parse(text);json=true}catch{}}catch{}
  try{validateHttpResponse("createBot",frame.status,frame.body);originalSchema=true}catch(error){if(error.message!=="C2_RESPONSE_SCHEMA")throw error}
  if(json&&schemas.$defs.ErrorCode.enum.includes(value?.error?.code))errorCode=value.error.code
  check(isDeepStrictEqual(before,await httpSql(runtime,entry,"facts",{},controller.signal)))
  console.log(JSON.stringify({stage:"http-framing-diagnostic",scope:"one-fixed-incomplete-body-idle-not-full-C2",status:frame.status,contentLength:result.framing.contentLength,transferEncoding:result.framing.transferEncoding,bodyBytes:frame.body.length,wireBytes:result.bytes,elapsedMs:result.elapsedMs,connectionClose:frame.headers.connection?.toLowerCase()==="close",containsHTML:result.framing.containsHTML,strictUTF8,json,originalSchema,errorCode,allNineFactsUnchanged:true}))
  const recovered=await httpCall(server,"getBot","GET","/api/bot/v1/bots/missing",{signal:controller.signal});check(recovered.status===404&&isDeepStrictEqual(before,await httpSql(runtime,entry,"facts",{},controller.signal)))
  console.log(JSON.stringify({stage:"http-diagnostic-recovery",status:404,actualAjv:true,allNineFactsUnchanged:true}))
}catch(error){failed=true;console.log(JSON.stringify({status:"failed",category:/^C2_[A-Z_]+$/.test(error.message)?error.message:"IO"}))}
finally{
  for(const finish of [async()=>{if(server)await server.stop()},stopHttpChildren,stopHttpSqlChildren,async()=>{if(fixture)await closeHttpFixture(fixture)}])try{await finish()}catch{failed=true}
  if(entry)try{console.log(JSON.stringify({stage:"http-diagnostic-cleanup",...await cleanupTestDatabase(entry)}));await httpAbsent(entry.project)}catch{failed=true}
  if(runtime)try{await closeDatabaseRuntime(runtime)}catch{failed=true}
  if(original)try{check(isDeepStrictEqual(original,await httpDevProof()));console.log(JSON.stringify({stage:"http-diagnostic-original-dev",sameIdsMountsNetwork:true,allHealthy:true,credentialsRead:false}))}catch{failed=true}
  clearTimeout(timer);process.removeListener("SIGTERM",cancel);if(failed)process.exitCode=1
}
