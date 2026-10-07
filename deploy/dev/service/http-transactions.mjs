import { isDeepStrictEqual } from "node:util"
import { startHttpJava } from "./http-java.mjs"
import { httpCall,rawHttpSocket } from "./http-client.mjs"
import { httpSql } from "./http-sql.mjs"

const check=x=>{if(!x)throw Error("C2_TRANSACTION_ASSERTION")}
export async function httpTransactions(runtime,entry,fixture,data,state,signal){
  const facts=()=>httpSql(runtime,entry,"facts",{},signal),{create,append,members}=data
  let a,b,reopened
  try{
    a=await startHttpJava(runtime,entry,fixture,"race-same",signal);b=await startHttpJava(runtime,entry,fixture,"race-same",signal)
    check(a.pid!==b.pid&&a.port!==b.port)
    const before=await facts(),body=create("race-identical")
    const requests=[a,b].map(server=>httpCall(server,"createBot","POST","/api/bot/v1/bots",{body,space:"race",signal}))
    const waiting=Promise.all(requests);waiting.catch(()=>{})
    await Promise.all([a.stage("before-scope"),b.stage("before-scope")]);a.release("go");b.release("go")
    const [one,two]=await waiting,after=await facts()
    check(one.status===201&&two.status===201&&one.body.equals(two.body))
    for(const table of ["bots","bot_versions","command_receipts","mutation_outbox"])check(after.rows[table]===before.rows[table]+1)
    console.log(JSON.stringify({stage:"http-same-command-race",pids:[a.pid,b.pid],ports:[a.port,b.port],bothBeforeScope:true,samePrincipal:true,identicalBytes:true,oneReceiptOneOutbox:true}))
    await a.stop();await b.stop()
    a=await startHttpJava(runtime,entry,fixture,"race-cas",signal);b=await startHttpJava(runtime,entry,fixture,"race-cas",signal)
    const casBefore=await facts(),path=`/api/bot/v1/bots/${one.value.bot.id}/versions`
    const competing=Promise.all([httpCall(a,"createBotVersion","POST",path,{body:append("cas-one",1),principal:"p1",space:"race",signal}),httpCall(b,"createBotVersion","POST",path,{body:append("cas-two",1),principal:"p2",space:"race",signal})]);competing.catch(()=>{})
    await Promise.all([a.stage("scoped"),b.stage("scoped")]);a.release("commit-go");b.release("commit-go")
    const results=await competing,casAfter=await facts()
    check(results.filter(r=>r.status===201).length===1&&results.filter(r=>r.status===409&&r.value.error.code==="VERSION_CONFLICT").length===1)
    for(const table of ["bot_versions","command_receipts","mutation_outbox"])check(casAfter.rows[table]===casBefore.rows[table]+1)
    const current=await httpCall(a,"getBot","GET",`/api/bot/v1/bots/${one.value.bot.id}`,{space:"race",signal});check(current.value.bot.version===2)
    console.log(JSON.stringify({stage:"http-cas-race",pids:[a.pid,b.pid],ports:[a.port,b.port],bothScopeTransactionsReached:true,principals:["p1","p2"],version:2,oneReceiptOneOutbox:true}))
    await a.stop();await b.stop();a=b=undefined
    const gp=`/api/bot/v1/groups/${state.g.id}/members`,bp=`/api/bot/v1/bots/${state.bot.bot.id}/versions`
    const groupBody=commandId=>({...data.group(commandId,state.bot),name:"rollback group"})
    const injections=[
      ["partial-version","createBot","POST","/api/bot/v1/bots",create("rollback-create")],
      ["partial-version","createBotVersion","POST",bp,append("rollback-version",2)],
      ["partial-members","createGroup","POST","/api/bot/v1/groups",groupBody("rollback-group")],
      ["partial-members","updateGroupMembers","PUT",gp,{commandId:"rollback-members",expectedVersion:5,members:members(),bots:state.g.bots}],
      ["before-receipt","createBot","POST","/api/bot/v1/bots",create("rollback-receipt")],
      ["before-commit","createGroup","POST","/api/bot/v1/groups",groupBody("rollback-commit")]
    ]
    for(const [mode,op,method,path,body] of injections){
      a=await startHttpJava(runtime,entry,fixture,mode,signal);const original=await facts(),result=await httpCall(a,op,method,path,{body,signal})
      check(result.status===503&&result.value.error.code==="DEPENDENCY_UNAVAILABLE"&&isDeepStrictEqual(original,await facts()))
      console.log(JSON.stringify({stage:"http-rollback",mode,operation:op,pid:a.pid,port:a.port,allNineFactsUnchanged:true}));await a.stop();a=undefined
    }
    a=await startHttpJava(runtime,entry,fixture,"lost-response",signal)
    const input=create("tcp-lost-response"),payload=Buffer.from(JSON.stringify(input)),beforeLost=await facts(),wire=await rawHttpSocket(a,"p1",signal)
    let received=0;wire.socket.on("data",chunk=>{received+=chunk.length})
    wire.socket.write(`POST /api/bot/v1/bots HTTP/1.1\r\nHost: 127.0.0.1:${wire.port}\r\nAuthorization: Bearer ${wire.token}\r\nX-DevClaw-Space: A\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);wire.socket.write(payload)
    try{
      await a.stage("committed");const receipt=await httpSql(runtime,entry,"receipt",{space:"A",principal:"p1",command:input.commandId},signal)
      check(receipt.httpStatus===201&&receipt.operation==="createBot"&&received===0)
      await new Promise(resolve=>{wire.socket.once("close",resolve);wire.socket.destroy()});a.release("response-go")
      const committed=await facts();for(const table of ["bots","bot_versions","command_receipts","mutation_outbox"])check(committed.rows[table]===beforeLost.rows[table]+1)
      const oldPid=a.pid,oldPort=a.port;await a.stop();a=undefined
      reopened=await startHttpJava(runtime,entry,fixture,"production",signal)
      const replay=await httpCall(reopened,"createBot","POST","/api/bot/v1/bots",{body:input,signal})
      check(replay.status===201&&replay.body.equals(Buffer.from(receipt.body,"base64"))&&replay.value.bot.id===receipt.target&&isDeepStrictEqual(committed,await facts()))
      console.log(JSON.stringify({stage:"http-lost-response",committedPid:oldPid,committedPort:oldPort,reopenedPid:reopened.pid,reopenedPort:reopened.port,wireBytesBeforeDisconnect:received,actualTCPDisconnectAfterCommit:true,originalIdAndBytes:true,allNineReplayFactsUnchanged:true}))
    }finally{wire.socket.destroy()}
    return {independentJvmRaces:2,rollbackGroups:injections.length,lostTCPAfterCommit:true}
  }finally{for(const server of [a,b,reopened])if(server)await server.stop()}
}
