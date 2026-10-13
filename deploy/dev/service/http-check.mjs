import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { createTestDatabase,startTestDatabase,cleanupTestDatabase,active } from "./test-database.mjs"
import { packagedDatabaseRuntime,closeDatabaseRuntime,javaDatabase } from "./database-java.mjs"
import { createHttpFixture,closeHttpFixture } from "./http-fixture.mjs"
import { startHttpJava,stopHttpChildren,httpChildFacts } from "./http-java.mjs"
import { httpCall,rawHttpSocket,validateHttpResponse } from "./http-client.mjs"
import { httpSql,stopHttpSqlChildren } from "./http-sql.mjs"
import { httpDevProof,httpCapacity,httpAbsent } from "./http-proof.mjs"
import { parseHttpFrames } from "./http-framing.mjs"
import { httpBusiness } from "./http-business.mjs"
import { httpTransactions } from "./http-transactions.mjs"
import { httpTransport } from "./http-transport.mjs"
import { httpStartup,httpOffline,stopHttpStartupChildren } from "./http-startup.mjs"

const filename=fileURLToPath(import.meta.url),check=(value)=>{if(!value)throw Error("C2_ASSERTION")}
const json=value=>Buffer.from(JSON.stringify(value))
export function httpPrincipals(references=true){
  const space=spaceId=>({spaceId,member:true,canCreateBot:true,canCreateGroup:true,knowledgeRefs:references?["allowed"]:[],repositoryRefs:references?["allowed"]:[],skillAllowlist:references?["allowed"]:[],capabilityCeiling:references?["repository.read"]:[]})
  const principals=["p1","p2","p3","p4","p9"].map(principalId=>({principalId,active:true,spaces:["A","B","race"].map(space)}))
  for(const s of principals[2].spaces){s.canCreateBot=false;s.canCreateGroup=false}
  principals.push({principalId:"foreign",active:true,spaces:[space("B")]},{principalId:"disabled",active:false,spaces:[space("A")]})
  return principals
}
function config(){return {description:"中文🚀\u0000\ud800",instructions:"instructions\udc00",knowledgeRefs:["allowed"],repositoryRefs:["allowed"],skillAllowlist:["allowed"],capabilityCeiling:["repository.read"],memoryPolicy:"explicit_only"}}
function create(commandId){return {commandId,name:"伙伴🚀\u0000\ud800y\udc00",config:config(),maintainerIds:["p2","p1"]}}
function append(commandId,expectedVersion){return {commandId,expectedVersion,config:{...config(),instructions:"immutable version two\udc00"}}}
function members(){return [{principalId:"p4",role:"admin"},{principalId:"p1",role:"admin"},{principalId:"p3",role:"participant"}]}
function group(commandId,bot){return {commandId,name:"群🚀\u0000\ud800",members:members(),bots:[{botId:bot.bot.id,botVersionId:bot.botVersion.id,role:"specialist"}],limits:{maxHandoffs:2,maxRuns:3,maxTokens:4}}}
function reverse(value){if(Array.isArray(value))return value.map(reverse);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverse(value[key])]));return value}
async function raw(handle,build,signal){
  const {socket,token,port}=await rawHttpSocket(handle,"p1",signal), chunks=[];let bytes=0
  try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>socket.destroy(),12000),done=()=>{clearTimeout(timer);resolve(Buffer.concat(chunks))}
    socket.on("data",chunk=>{bytes+=chunk.length;if(bytes>1100000){socket.destroy();reject(Error("C2_RAW_BOUND"))}else chunks.push(chunk)})
    socket.once("close",done);socket.write(build({token,port}));
  })}finally{socket.destroy()}
}
function parseRaw(bytes){
  const frames=parseHttpFrames(bytes);check(frames.length===1);return frames[0]
}
async function protocol(handle,runtime,entry,signal){
  let cases=0
  const facts=()=>httpSql(runtime,entry,"facts",{},signal)
  const before=await facts()
  const base=({token,port})=>`Host: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nX-DevClaw-Space: A\r\nConnection: close\r\n`
  for(const [label,build,expected] of [
    ["ordinary-ows",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}\r\n`,404],
    ["tab-ows",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x).replace("Host: ","hOsT:\t")}\r\n`,404],
    ["body-fake-head",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}Content-Length: 47\r\n\r\ncontent-length:0\r\ntransfer-encoding:chunked\r\n\r\n`,400],
    ["cl-te",x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,400],
    ["cl-te-mixed",x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}content-type:\tapplication/json\r\ncOnTeNt-LeNgTh:\t2\r\ntRaNsFeR-EnCoDiNg:\tchunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,400],
    ["duplicate-auth",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}Authorization: Bearer ${x.token}\r\n\r\n`,401],
    ["merged-auth",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x).replace(`Bearer ${x.token}`,`Bearer ${x.token},Bearer ${x.token}`)}\r\n`,401],
    ["duplicate-space",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}X-DevClaw-Space: A\r\n\r\n`,400],
    ["absolute-form",x=>`GET http://127.0.0.1:${x.port}/api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}\r\n`,400],
    ["visible-fold",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}X-Extra: a\r\n b\r\n\r\n`,400],
    ["cl-te-fold",x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding:\r\n chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,400]
  ]){
    const result=parseRaw(await raw(handle,build,signal));check(result.status===expected)
    validateHttpResponse("getBot",result.status,result.body)
    check(isDeepStrictEqual(before,await facts()));cases++;console.log(JSON.stringify({stage:"http-raw-case",label,status:result.status,category:"ordinary-api-json",actualAjv:true,allNineFactsUnchanged:true}))
  }
  // Both requests already occupy the socket buffer: nextRequest must compact
  // exactly the remaining current request, not an old body or stale header.
  const pipeline=parseHttpFrames(await raw(handle,x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x).replace("Connection: close","Connection: keep-alive")}\r\nGET /api/bot/v1/bots/%6dissing HTTP/1.1\r\n${base(x)}\r\n`,signal))
  check(pipeline.length===2);for(const frame of pipeline){check(frame.status===404);validateHttpResponse("getBot",frame.status,frame.body)}check(isDeepStrictEqual(before,await facts()));cases++
  console.log(JSON.stringify({stage:"http-pipeline-proof",frames:2,eachActualAjv:true,noResidual:true,allNineFactsUnchanged:true}))
  return cases
}
export async function httpCheck(signal){
  active(signal);const originalDev=await httpDevProof();active(signal)
  const runtime=await packagedDatabaseRuntime();const projects=[]
  try{
    active(signal)
    for(let iteration=1;iteration<=2;iteration++){
      console.log(JSON.stringify(await httpCapacity(signal)));active(signal);const entry=await createTestDatabase()
      let fixture,server
      try{
        active(signal)
        console.log(JSON.stringify({stage:"http-registered",project:entry.project,iteration}));console.log(JSON.stringify({stage:"http-database-ready",...await startTestDatabase(entry,signal)}));active(signal)
        fixture=await createHttpFixture(httpPrincipals(),signal)
        await httpStartup(runtime,entry,fixture,signal,{unmigrated:true})
        for(const expected of [6,0]){const migration=await javaDatabase(runtime,entry,"migrate",{signal});check(migration.exitCode===0&&migration.proof.migrations===expected)}
        const startupNegatives=1+await httpStartup(runtime,entry,fixture,signal)
        server=await startHttpJava(runtime,entry,fixture,"production",signal)
        console.log(JSON.stringify({stage:"http-listener",pid:server.pid,port:server.port,project:entry.project,productionEOF:true}))
        const first=await httpCall(server,"createBot","POST","/api/bot/v1/bots",{body:create("create"),signal});check(first.status===201)
        const bot=first.value,read=await httpCall(server,"getBot","GET",`/api/bot/v1/bots/${bot.bot.id}`,{signal});check(read.status===200&&read.value.botVersion.id===bot.botVersion.id)
        const version=await httpCall(server,"createBotVersion","POST",`/api/bot/v1/bots/${bot.bot.id}/versions`,{body:append("append",1),signal});check(version.status===201&&version.value.bot.version===2)
        const createdGroup=await httpCall(server,"createGroup","POST","/api/bot/v1/groups",{body:group("group",bot),signal});check(createdGroup.status===201)
        const g=createdGroup.value.group,groupRead=await httpCall(server,"getGroup","GET",`/api/bot/v1/groups/${g.id}`,{principal:"p4",signal});check(groupRead.status===200&&groupRead.value.group.bots[0].botVersionId===bot.botVersion.id)
        const update={commandId:"update",expectedVersion:1,members:members(),bots:g.bots},updated=await httpCall(server,"updateGroupMembers","PUT",`/api/bot/v1/groups/${g.id}/members`,{principal:"p4",body:update,signal});check(updated.status===200&&updated.value.group.version===2)
        for(const [operation,method,path,body,principal,original] of [["createBot","POST","/api/bot/v1/bots",create("create"),"p1",first],["createBotVersion","POST",`/api/bot/v1/bots/${bot.bot.id}/versions`,append("append",1),"p1",version],["createGroup","POST","/api/bot/v1/groups",group("group",bot),"p1",createdGroup],["updateGroupMembers","PUT",`/api/bot/v1/groups/${g.id}/members`,update,"p4",updated]]){
          const before=await httpSql(runtime,entry,"facts",{},signal),result=await httpCall(server,operation,method,path,{body:json(reverse(body)),principal,signal});check(result.status===original.status&&result.body.equals(original.body));check(isDeepStrictEqual(before,await httpSql(runtime,entry,"facts",{},signal)))
        }
        const business=await httpBusiness(server,runtime,entry,{create,append,group,members,reverse},{first,bot,version,createdGroup,g,update,updated},signal)
        const rawCases=await protocol(server,runtime,entry,signal)
        const transport=await httpTransport(server,runtime,entry,create,signal)
        const transactions=await httpTransactions(runtime,entry,fixture,{create,append,group,members},{bot,g},signal)
        await server.stop();server=await startHttpJava(runtime,entry,fixture,"production",signal)
        console.log(JSON.stringify({stage:"http-reopened-listener",pid:server.pid,port:server.port,project:entry.project}))
        const reopened=await httpCall(server,"getBot","GET",`/api/bot/v1/bots/${bot.bot.id}`,{signal});check(reopened.value.bot.version===2&&reopened.value.bot.name===bot.bot.name)
        const reopenedGroup=await httpCall(server,"getGroup","GET",`/api/bot/v1/groups/${g.id}`,{principal:"p4",signal});check(reopenedGroup.value.group.version===business.groupVersion&&isDeepStrictEqual(reopenedGroup.value.group.bots,g.bots))
        check(isDeepStrictEqual(reopenedGroup.value.group.members,members())&&isDeepStrictEqual(reopened.value.bot.maintainerIds,create("unused").maintainerIds))
        await server.stop();await closeHttpFixture(fixture);fixture=await createHttpFixture(httpPrincipals(false),signal);server=await startHttpJava(runtime,entry,fixture,"production",signal)
        console.log(JSON.stringify({stage:"http-policy-reopened-listener",pid:server.pid,port:server.port,project:entry.project}))
        const beforePolicy=await httpSql(runtime,entry,"facts",{},signal)
        for(const [op,path,body,original] of [["createBotVersion",`/api/bot/v1/bots/${bot.bot.id}/versions`,append("append",1),version],["createGroup","/api/bot/v1/groups",group("group",bot),createdGroup]]){
          const replay=await httpCall(server,op,"POST",path,{body,signal});check(replay.status===original.status&&replay.body.equals(original.body))
        }
        const newPolicy=await httpCall(server,"createBot","POST","/api/bot/v1/bots",{body:create("withdrawn-policy"),signal});check(newPolicy.status===403&&isDeepStrictEqual(beforePolicy,await httpSql(runtime,entry,"facts",{},signal)))
        await server.stop();server=undefined;await httpOffline(entry,runtime,fixture,signal)
        console.log(JSON.stringify({stage:"http-core-proof",iteration,project:entry.project,sixRealHTTP:true,reopened:true,policyWithdrawnHistoricalBytes:true,startupNegatives,...business,...transport,...transactions,rawCases,scope:"HTTP-full-check-lifecycle-and-old-regressions-pending"}));projects.push(entry.project)
      }finally{
        let failed=false
        for(const finish of [async()=>{if(server)await server.stop()},stopHttpChildren,stopHttpSqlChildren,stopHttpStartupChildren,async()=>{if(fixture)await closeHttpFixture(fixture)}])try{await finish()}catch{failed=true}
        try{console.log(JSON.stringify({stage:"http-cleanup",...await cleanupTestDatabase(entry)}));await httpAbsent(entry.project)}catch{failed=true;console.log(JSON.stringify({stage:"http-cleanup",project:entry.project,status:"failed"}))}
        if(failed)throw Error("C2_CLEANUP_FAILURE")
      }
    }
    return {status:"verified",scope:"HTTP-check-full-lifecycle-and-old-regressions-separate",sequentialDatabases:2,projects,...httpChildFacts()}
  }finally{
    let failed=false
    for(const finish of [stopHttpChildren,stopHttpSqlChildren,stopHttpStartupChildren,()=>closeDatabaseRuntime(runtime)])try{await finish()}catch{failed=true}
    try{check(isDeepStrictEqual(await httpDevProof(),originalDev));console.log(JSON.stringify({stage:"http-original-dev-proof",sameIdsMountsNetwork:true,allHealthy:true,credentialsRead:false}))}catch{failed=true}
    if(failed)throw Error("C2_FINAL_CLEANUP_FAILURE")
  }
}
if(process.argv[1]&&resolve(process.argv[1])===filename){
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,1800000);process.once("SIGTERM",cancel);process.once("SIGINT",cancel)
  try{if(process.argv.length!==2)throw Error("C2_ARGUMENTS");console.log(JSON.stringify(await httpCheck(controller.signal)))}
  catch(error){console.log(JSON.stringify({status:"failed",category:controller.signal.aborted?"CANCELLED":/^C2_[A-Z_]+$/.test(error.message)?error.message:"IO"}));process.exitCode=1}
  finally{clearTimeout(timer);await stopHttpChildren();await stopHttpSqlChildren();await stopHttpStartupChildren();process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel)}
}
