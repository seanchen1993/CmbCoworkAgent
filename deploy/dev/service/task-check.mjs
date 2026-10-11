import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { createTestDatabase,startTestDatabase,cleanupTestDatabase,active } from "./test-database.mjs"
import { packagedDatabaseRuntime,closeDatabaseRuntime,javaDatabase } from "./database-java.mjs"
import { createHttpFixture,closeHttpFixture } from "./http-fixture.mjs"
import { startHttpJava,stopHttpChildren,httpChildFacts } from "./http-java.mjs"
import { httpCall,rawHttpSocket } from "./http-client.mjs"
import { httpDevProof,httpCapacity,httpAbsent } from "./http-proof.mjs"
import { httpPrincipals } from "./http-check.mjs"
import { taskSql,stopTaskSqlChildren } from "./task-sql.mjs"

const filename=fileURLToPath(import.meta.url),check=value=>{if(!value)throw Error("B02_ASSERTION")}
// Emit codes and fixed stages only, never arbitrary child output or error text.
export const taskFailureCategory=error=>/^(?:B02|B1|C2)_[A-Z_]+$/.test(error?.message)?error.message:"IO"
const databaseCategory=value=>["CONFIG_INVALID","SECRET_INVALID","DB_AUTH","DB_UNAVAILABLE","DB_TIMEOUT","DB_CONFIGURATION","MIGRATION_INVALID","STORAGE_INVALID"].includes(value)?value:"UNKNOWN"
const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverse(value[key])])):value
const config={description:"中文🚀\u0000\ud800",instructions:"text only",knowledgeRefs:[],repositoryRefs:[],skillAllowlist:[],capabilityCeiling:["repository.read"],memoryPolicy:"disabled"}
const createBot=commandId=>({commandId,name:"伙伴",config,maintainerIds:["p1","p2"]})
const createTask=(commandId,groupId)=>({commandId,groupId,title:"Task🚀\u0000\ud800",goal:"Goal\udc00",inputArtifactVersions:[]})
const message=(commandId,expectedVersion,text="中文🚀\u0000\ud800\udc00")=>({commandId,expectedVersion,text,artifactVersions:[]})
const members=()=>[{principalId:"p1",role:"admin"},{principalId:"p2",role:"participant"}]

async function oldSmoke(server,signal){
  const bot=await httpCall(server,"createBot","POST","/api/bot/v1/bots",{body:createBot("old-bot"),signal});check(bot.status===201)
  const read=await httpCall(server,"getBot","GET",`/api/bot/v1/bots/${bot.value.bot.id}`,{signal});check(read.status===200)
  const version=await httpCall(server,"createBotVersion","POST",`/api/bot/v1/bots/${bot.value.bot.id}/versions`,{body:{commandId:"old-version",expectedVersion:1,config},signal});check(version.status===201)
  const g=await httpCall(server,"createGroup","POST","/api/bot/v1/groups",{body:{commandId:"old-group",name:"Group",members:members(),bots:[{botId:bot.value.bot.id,botVersionId:bot.value.botVersion.id,role:"specialist"}],limits:{maxHandoffs:1,maxRuns:1,maxTokens:1}},signal});check(g.status===201)
  const group=g.value.group,readGroup=await httpCall(server,"getGroup","GET",`/api/bot/v1/groups/${group.id}`,{principal:"p2",signal});check(readGroup.status===200&&readGroup.value.group.bots[0].botVersionId===bot.value.botVersion.id)
  const update=await httpCall(server,"updateGroupMembers","PUT",`/api/bot/v1/groups/${group.id}/members`,{body:{commandId:"old-members",expectedVersion:1,members:members(),bots:group.bots},signal});check(update.status===200)
  return {bot:bot.value,group:update.value.group,botReceipt:bot}
}
async function taskBusiness(server,runtime,entry,state,signal){
  const facts=()=>taskSql(runtime,entry,"facts",{},signal);let denials=0,replays=0
  const call=(op,method,path,options={})=>httpCall(server,op,method,path,{signal,...options})
  const denied=async(op,method,path,options,status,code)=>{const before=await facts(),r=await call(op,method,path,options);check(r.status===status&&r.value.error.code===code&&isDeepStrictEqual(before,await facts()));denials++;return r}
  const group=state.group,body=createTask("task-create",group.id)
  const empty=await call("getEvents","GET","/api/bot/v1/events");check(empty.status===200&&empty.value.events.length===0&&!empty.value.hasMore)
  const created=await call("createTask","POST","/api/bot/v1/tasks",{body});check(created.status===201)
  const task=created.value.task,path=`/api/bot/v1/tasks/${task.id}`,mp=`${path}/messages`
  check(task.version===1&&task.status==="active"&&task.stages.length===5&&task.currentStageId===task.stages[0].id)
  check(isDeepStrictEqual(task.stages.map(x=>x.kind),["requirement","assessment","prototype","scope_confirmation","development"])&&isDeepStrictEqual(task.stages.map(x=>x.status),["active","pending","pending","pending","pending"]))
  const first=await call("getTask","GET",path,{principal:"p2"});check(first.status===200&&isDeepStrictEqual(first.value.task,task))
  const initialCursor=first.value.snapshotCursor
  const artifact={artifactId:"artifact",versionId:"version",digest:`sha256:${"0".repeat(64)}`}
  await denied("createTask","POST","/api/bot/v1/tasks",{body:{...body,commandId:"artifact-task",inputArtifactVersions:[artifact]}},409,"INPUT_CHANGED")
  await denied("createTask","POST","/api/bot/v1/tasks",{body:{...body,commandId:"missing-group",groupId:"missing"}},404,"NOT_FOUND")
  await denied("createTask","POST","/api/bot/v1/tasks",{body:{...body,commandId:"nonmember"},principal:"p3"},403,"FORBIDDEN")
  await denied("getTask","GET",path,{principal:"p3"},403,"FORBIDDEN")
  await denied("getTask","GET",path,{space:"B"},404,"NOT_FOUND")
  await denied("createTaskMessage","POST",mp,{body:message("stale",2)},409,"VERSION_CONFLICT")
  await denied("createTaskMessage","POST",mp,{body:{...message("artifact-message",1),artifactVersions:[artifact]}},409,"INPUT_CHANGED")
  await denied("createTaskMessage","POST",mp,{body:{...message("target-invalid",1),targetBotId:"missing"}},400,"INVALID_PAYLOAD")
  await denied("createTaskMessage","POST",mp,{body:message("nonmember-message",1),principal:"p3"},403,"FORBIDDEN")
  const mbody={...message("message-create",1),targetBotId:state.bot.bot.id}
  const sent=await call("createTaskMessage","POST",mp,{principal:"p2",body:mbody});check(sent.status===201&&sent.value.taskVersion===2&&sent.value.message.authorPrincipalId==="p2"&&sent.value.message.text===mbody.text)
  for(const [op,p,b,principal,original]of[["createTask","/api/bot/v1/tasks",body,"p1",created],["createTaskMessage",mp,mbody,"p2",sent]]){
    const before=await facts(),r=await call(op,"POST",p,{body:reverse(b),principal});check(r.status===201&&r.body.equals(original.body)&&isDeepStrictEqual(before,await facts()));replays++
  }
  for(const number of["1.0","1e0"]){const before=await facts(),raw=Buffer.from(JSON.stringify(reverse(mbody)).replace('"expectedVersion":1',`"expectedVersion":${number}`)),r=await call("createTaskMessage","POST",mp,{principal:"p2",body:raw});check(r.body.equals(sent.body)&&isDeepStrictEqual(before,await facts()));replays++}
  await denied("createTaskMessage","POST",mp,{principal:"p2",body:{...mbody,expectedVersion:2}},409,"COMMAND_CONFLICT")
  await denied("createTask","POST","/api/bot/v1/tasks",{body:{...body,title:"changed"}},409,"COMMAND_CONFLICT")
  await denied("createTask","POST","/api/bot/v1/tasks",{body:{...body,commandId:"old-bot"}},409,"COMMAND_CONFLICT")
  await denied("createBot","POST","/api/bot/v1/bots",{body:createBot("task-create")},409,"COMMAND_CONFLICT")
  await denied("createGroup","POST","/api/bot/v1/groups",{body:{commandId:"task-create",name:"new",members:members(),bots:group.bots,limits:group.limits}},409,"COMMAND_CONFLICT")
  const later=await call("getTask","GET",path);check(later.value.task.version===2&&later.value.task.taskNumber===task.taskNumber)
  const events=await call("getEvents","GET",`/api/bot/v1/events?after=${initialCursor}&limit=1`,{principal:"p2"});check(events.value.events.length===1&&events.value.events[0].entityRef.version===2&&!events.value.hasMore)
  const all=await call("getEvents","GET",`/api/bot/v1/events?after=${empty.value.nextCursor}&limit=1`);check(all.value.events.length===1&&all.value.hasMore&&all.value.events[0].entityRef.version===1)
  const second=await call("getEvents","GET",`/api/bot/v1/events?after=${all.value.nextCursor}&limit=1`);check(second.value.events.length===1&&!second.value.hasMore&&second.value.events[0].seq===all.value.events[0].seq+1)
  const invisible=await call("getEvents","GET",`/api/bot/v1/events?after=${empty.value.nextCursor}&limit=1`,{principal:"p3"});check(invisible.value.events.length===0&&invisible.value.hasMore)
  const invisible2=await call("getEvents","GET",`/api/bot/v1/events?after=${invisible.value.nextCursor}&limit=1`,{principal:"p3"});check(invisible2.value.events.length===0&&!invisible2.value.hasMore)
  await denied("getEvents","GET",`/api/bot/v1/events?after=${initialCursor}`,{space:"B"},410,"CURSOR_EXPIRED")
  await denied("getEvents","GET","/api/bot/v1/events?after=unknown",{},410,"CURSOR_EXPIRED")
  await taskSql(runtime,entry,"expire-cursor",{space:"A",cursor:initialCursor},signal)
  await denied("getEvents","GET",`/api/bot/v1/events?after=${initialCursor}`,{},410,"CURSOR_EXPIRED")
  for(const query of["limit=0","limit=201","limit=1.0","limit=1&limit=2","after=a&after=b","unknown=1","after=%253A"])
    await denied("getEvents","GET",`/api/bot/v1/events?${query}`,{},400,"INVALID_PAYLOAD")
  const other=await call("createTask","POST","/api/bot/v1/tasks",{body:createTask("other-task",group.id)});check(other.value.task.taskNumber!==task.taskNumber)
  await denied("createTaskMessage","POST",`/api/bot/v1/tasks/${other.value.task.id}/messages`,{principal:"p2",body:mbody},409,"COMMAND_CONFLICT")
  const maximum=message("maximum-text",2,"🚀".repeat(16384));const large=await call("createTaskMessage","POST",mp,{body:maximum});check(large.status===201&&large.value.message.text===maximum.text&&large.value.taskVersion===3)
  const revoked=await call("updateGroupMembers","PUT",`/api/bot/v1/groups/${group.id}/members`,{body:{commandId:"revoke-task-member",expectedVersion:group.version,members:[members()[0]],bots:group.bots}});check(revoked.status===200)
  await denied("getTask","GET",path,{principal:"p2"},403,"FORBIDDEN")
  await denied("createTaskMessage","POST",mp,{principal:"p2",body:mbody},403,"FORBIDDEN")
  await denied("createTaskMessage","POST",mp,{principal:"p2",body:{...mbody,text:"changed"}},403,"FORBIDDEN")
  const filtered=await call("getEvents","GET",`/api/bot/v1/events?after=${empty.value.nextCursor}`,{principal:"p2"});check(filtered.value.events.length===0&&!filtered.value.hasMore)
  // Current authorization also precedes an old/new conflicting receipt lookup.
  await denied("createBot","POST","/api/bot/v1/bots",{principal:"p2",body:createBot("message-create")},403,"FORBIDDEN")
  await taskSql(runtime,entry,"expire-command",{space:"A",principal:"p1",command:"task-create"},signal)
  await denied("createTask","POST","/api/bot/v1/tasks",{body},409,"COMMAND_EXPIRED")
  console.log(JSON.stringify({stage:"task-business",denials,replays,fourHTTP:true,currentGroupAuthorization:true,scanHighWater:true,unicodeAndMaximumText:true,noExecution:true}))
  return {task,other:other.value.task,group:revoked.value.group,body,mbody,sent,created,resumeCursor:later.value.snapshotCursor,denials,replays}
}
async function taskTransactions(runtime,entry,fixture,state,production,signal){
  const facts=()=>taskSql(runtime,entry,"facts",{},signal);let a,b;const path=`/api/bot/v1/tasks/${state.other.id}/messages`
  try{
    // Reuse the ordinary listener for restore, before creating gated race fixtures.
    const restored=await httpCall(production,"updateGroupMembers","PUT",`/api/bot/v1/groups/${state.group.id}/members`,{body:{commandId:"restore-task-member",expectedVersion:state.group.version,members:members(),bots:state.group.bots},signal});check(restored.status===200)
    a=await startHttpJava(runtime,entry,fixture,"race-cas",signal);b=await startHttpJava(runtime,entry,fixture,"race-cas",signal)
    const before=await facts(),waiting=Promise.all([httpCall(a,"createTaskMessage","POST",path,{body:message("cas-a",1),signal}),httpCall(b,"createTaskMessage","POST",path,{body:message("cas-b",1),principal:"p2",signal})]);waiting.catch(()=>{})
    await Promise.all([a.stage("scoped"),b.stage("scoped")]);check(a.pid!==b.pid&&a.port!==b.port);a.release("commit-go");b.release("commit-go")
    const results=await waiting,after=await facts();check(results.filter(x=>x.status===201).length===1&&results.filter(x=>x.status===409&&x.value.error.code==="VERSION_CONFLICT").length===1)
    for(const table of["task_messages","command_receipts","mutation_outbox"])check(after.rows[table]===before.rows[table]+1)
    console.log(JSON.stringify({stage:"task-cas-race",pids:[a.pid,b.pid],ports:[a.port,b.port],bothScopedBeforeRelease:true,principals:["p1","p2"],oneCommit:true}));await a.stop();await b.stop();a=b=undefined
    a=await startHttpJava(runtime,entry,fixture,"race-same",signal);b=await startHttpJava(runtime,entry,fixture,"race-same",signal)
    const same=createTask("race-same-task",state.group.id),sameBefore=await facts(),requests=Promise.all([a,b].map(server=>httpCall(server,"createTask","POST","/api/bot/v1/tasks",{body:same,signal})));requests.catch(()=>{})
    await Promise.all([a.stage("before-scope"),b.stage("before-scope")]);a.release("go");b.release("go");const sameResults=await requests,sameAfter=await facts();check(sameResults.every(x=>x.status===201)&&sameResults[0].body.equals(sameResults[1].body))
    for(const table of["tasks","command_receipts","mutation_outbox"])check(sameAfter.rows[table]===sameBefore.rows[table]+1)
    console.log(JSON.stringify({stage:"task-same-command-race",pids:[a.pid,b.pid],ports:[a.port,b.port],bothBeforeScope:true,oneTaskReceiptOutbox:true}));await a.stop();await b.stop();a=b=undefined
    let rollbacks=0
    for(const[mode,op,p,body]of[["partial-version","createTask","/api/bot/v1/tasks",createTask("rollback-task",state.group.id)],["partial-members","createTaskMessage",path,message("rollback-message",2)],["before-receipt","createTaskMessage",path,message("rollback-receipt",2)],["before-commit","createTask","/api/bot/v1/tasks",createTask("rollback-commit",state.group.id)]]){
      a=await startHttpJava(runtime,entry,fixture,mode,signal);const before=await facts(),r=await httpCall(a,op,"POST",p,{body,signal});check(r.status===503&&r.value.error.code==="DEPENDENCY_UNAVAILABLE"&&isDeepStrictEqual(before,await facts()));rollbacks++;await a.stop();a=undefined
    }
    a=await startHttpJava(runtime,entry,fixture,"lost-response",signal);const body=createTask("lost-task",state.group.id),payload=Buffer.from(JSON.stringify(body)),wire=await rawHttpSocket(a,"p1",signal);let received=0;wire.socket.on("data",chunk=>{received+=chunk.length})
    try{
      wire.socket.write(`POST /api/bot/v1/tasks HTTP/1.1\r\nHost: 127.0.0.1:${wire.port}\r\nAuthorization: Bearer ${wire.token}\r\nX-DevClaw-Space: A\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);wire.socket.write(payload)
      await a.stage("committed");check(received===0);const original=await taskSql(runtime,entry,"receipt",{space:"A",principal:"p1",command:"lost-task"},signal);const committed=await facts();wire.socket.destroy();a.release("response-go");await a.stop();a=undefined
      a=await startHttpJava(runtime,entry,fixture,"production",signal);const before=await facts(),one=await httpCall(a,"createTask","POST","/api/bot/v1/tasks",{body,signal}),two=await httpCall(a,"createTask","POST","/api/bot/v1/tasks",{body:reverse(body),signal});check(one.status===201&&one.value.task.id===original.target&&one.body.equals(Buffer.from(original.body,"base64"))&&one.body.equals(two.body)&&isDeepStrictEqual(committed,before)&&isDeepStrictEqual(before,await facts()))
      console.log(JSON.stringify({stage:"task-transaction-proof",independentJvmRaces:2,rollbacks,lostResponseAfterCommit:true,reopenedOriginalBytes:true,wireBytesBeforeDisconnect:received}))
    }finally{wire.socket.destroy()}
  }finally{for(const server of[a,b])if(server)await server.stop()}
}
export async function taskCheck(signal){
  active(signal);const originalDev=await httpDevProof();active(signal);const runtime=await packagedDatabaseRuntime();const projects=[]
  try{
    active(signal)
    for(let iteration=1;iteration<=2;iteration++){
      console.log(JSON.stringify(await httpCapacity(signal)));active(signal);const entry=await createTestDatabase();let fixture,server
      try{
        active(signal);console.log(JSON.stringify({stage:"task-registered",iteration,project:entry.project}));console.log(JSON.stringify({stage:"task-database-ready",...await startTestDatabase(entry,signal)}));active(signal)
        console.log(JSON.stringify({stage:"task-identity-start",iteration}));fixture=await createHttpFixture(httpPrincipals(),signal)
        console.log(JSON.stringify({stage:"task-identity-ready",iteration}))
        let legacy,seed
        if(iteration===2){seed=await taskSql(runtime,entry,"v1",{},signal);legacy=await taskSql(runtime,entry,"legacy",{},signal)}
        console.log(JSON.stringify({stage:"task-migration-start",iteration}))
        const migration=await javaDatabase(runtime,entry,"migrate",{signal})
        console.log(JSON.stringify({stage:"task-migration-result",iteration,exitCode:migration.exitCode,...(migration.exitCode===0?{migrations:migration.proof.migrations}:{category:databaseCategory(migration.proof.category)})}))
        check(migration.exitCode===0&&migration.proof.migrations===(iteration===1?2:1))
        const noop=await javaDatabase(runtime,entry,"migrate",{signal});check(noop.exitCode===0&&noop.proof.migrations===0)
        if(legacy)check(isDeepStrictEqual(legacy,await taskSql(runtime,entry,"legacy",{},signal)))
        server=await startHttpJava(runtime,entry,fixture,"production",signal);console.log(JSON.stringify({stage:"task-listener",project:entry.project,pid:server.pid,port:server.port}))
        if(seed){const preserved=await httpCall(server,"getGroup","GET",`/api/bot/v1/groups/${seed.group}`,{signal});check(preserved.status===200&&preserved.value.group.bots[0].botVersionId===seed.botVersion)}
        const old=await oldSmoke(server,signal),state=await taskBusiness(server,runtime,entry,old,signal)
        await taskTransactions(runtime,entry,fixture,state,server,signal)
        await server.stop();server=await startHttpJava(runtime,entry,fixture,"production",signal)
        const reopened=await httpCall(server,"getTask","GET",`/api/bot/v1/tasks/${state.task.id}`,{signal});check(reopened.status===200&&reopened.value.task.title===state.task.title&&reopened.value.task.version===3)
        const replay=await httpCall(server,"createTaskMessage","POST",`/api/bot/v1/tasks/${state.task.id}/messages`,{principal:"p2",body:state.mbody,signal});check(replay.status===201&&replay.body.equals(state.sent.body))
        const resumed=await httpCall(server,"getEvents","GET",`/api/bot/v1/events?after=${state.resumeCursor}`,{principal:"p2",signal});check(resumed.status===200&&resumed.value.events.some(event=>event.taskId===state.task.id&&event.entityRef.version===3)&&!resumed.value.hasMore)
        console.log(JSON.stringify({stage:"task-proof",iteration,project:entry.project,emptyOrV1Upgrade:iteration===1?"empty-V1-V2":"actual-V1-data-preserved",legacyNineFactsPreserved:iteration===2,fourRealHTTP:true,oldSixSmoke:true,reopened:true,noExecution:true,...{denials:state.denials,replays:state.replays}}));projects.push(entry.project)
      }finally{
        let failed=false;for(const finish of[async()=>{if(server)await server.stop()},stopHttpChildren,stopTaskSqlChildren,async()=>{if(fixture)await closeHttpFixture(fixture)}])try{await finish()}catch{failed=true}
        try{console.log(JSON.stringify({stage:"task-cleanup",...await cleanupTestDatabase(entry)}));await httpAbsent(entry.project)}catch{failed=true}
        if(failed)throw Error("B02_CLEANUP_FAILURE")
      }
    }
    return{status:"verified",sequentialDatabases:2,projects,...httpChildFacts()}
  }finally{
    let failed=false;for(const finish of[stopHttpChildren,stopTaskSqlChildren,()=>closeDatabaseRuntime(runtime)])try{await finish()}catch{failed=true}
    try{check(isDeepStrictEqual(originalDev,await httpDevProof()));console.log(JSON.stringify({stage:"task-original-dev",sameIdentityHealthy:true,credentialsRead:false}))}catch{failed=true}
    if(failed)throw Error("B02_FINAL_CLEANUP_FAILURE")
  }
}
if(process.argv[1]&&resolve(process.argv[1])===filename){
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,1200000);process.once("SIGTERM",cancel);process.once("SIGINT",cancel)
  try{if(process.argv.length!==2)throw Error("B02_ARGUMENTS");console.log(JSON.stringify(await taskCheck(controller.signal)))}catch(error){console.log(JSON.stringify({status:"failed",category:controller.signal.aborted?"CANCELLED":taskFailureCategory(error)}));process.exitCode=1}
  finally{clearTimeout(timer);await stopHttpChildren();await stopTaskSqlChildren();process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel)}
}
