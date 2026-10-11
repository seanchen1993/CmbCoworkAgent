import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { ownedProcess,isolatedEnv } from "../process.mjs"
import { active,createTestDatabase,startTestDatabase,cleanupTestDatabase } from "./test-database.mjs"
import { packagedDatabaseRuntime,closeDatabaseRuntime,javaDatabase } from "./database-java.mjs"
import { createHttpFixture,closeHttpFixture } from "./http-fixture.mjs"
import { httpPrincipals } from "./http-check.mjs"
import { startHttpJava,stopHttpChildren,httpChildFacts } from "./http-java.mjs"
import { httpCall } from "./http-client.mjs"
import { stopHttpSqlChildren } from "./http-sql.mjs"
import { httpDevProof,httpCapacity,httpAbsent } from "./http-proof.mjs"

const filename=fileURLToPath(import.meta.url),root=fileURLToPath(new URL("../../../",import.meta.url)),check=x=>{if(!x)throw Error("C2_LIFECYCLE_ASSERTION")}
async function absentFile(path){try{await lstat(path);throw Error("C2_PRIVATE_RESIDUE")}catch(error){if(error.code!=="ENOENT")throw error}}
async function childCase(mode){
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,240000);process.once("SIGTERM",cancel);process.once("SIGINT",cancel)
  let runtime,entry,fixture,server,cleanupFailed=false
  try{
    active(controller.signal);runtime=await packagedDatabaseRuntime();active(controller.signal);await httpCapacity(controller.signal);active(controller.signal)
    entry=await createTestDatabase();active(controller.signal)
    console.log(JSON.stringify({stage:"http-life-registered",project:entry.project,runtimeDirectory:runtime.dir}))
    console.log(JSON.stringify({stage:"http-life-db",...await startTestDatabase(entry,controller.signal)}));active(controller.signal)
    fixture=await createHttpFixture(httpPrincipals(),controller.signal);console.log(JSON.stringify({stage:"http-life-fixture",directory:fixture.dir}))
    if(mode==="secret-sigterm"){
      console.log(JSON.stringify({stage:"http-secret-check",project:entry.project}))
      await startHttpJava(runtime,entry,fixture,"production",controller.signal)
      throw Error("C2_CANCEL_NOT_OBSERVED")
    }
    const migration=await javaDatabase(runtime,entry,"migrate",{signal:controller.signal});check(migration.exitCode===0&&migration.proof.migrations===4)
    server=await startHttpJava(runtime,entry,fixture,"production",controller.signal)
    const request=await httpCall(server,"getBot","GET","/api/bot/v1/bots/missing",{signal:controller.signal});check(request.status===404)
    console.log(JSON.stringify({stage:"http-life-request",pid:server.pid,port:server.port,status:404,actualAjv:true}))
    if(mode==="injected")throw Error("C2_INJECTED")
    if(!controller.signal.aborted)await new Promise(resolve=>controller.signal.addEventListener("abort",resolve,{once:true}))
    throw Error("C2_CANCELLED")
  }catch(error){console.log(JSON.stringify({stage:"http-life-failure",category:controller.signal.aborted?"C2_CANCELLED":/^C2_[A-Z_]+$/.test(error.message)?error.message:"IO",...httpChildFacts()}))}
  finally{
    for(const finish of [async()=>{if(server)await server.stop()},stopHttpChildren,stopHttpSqlChildren,async()=>{if(fixture)await closeHttpFixture(fixture)}])try{await finish()}catch{cleanupFailed=true}
    if(entry)try{const cleanup=await cleanupTestDatabase(entry);await httpAbsent(entry.project);console.log(JSON.stringify({stage:"http-life-cleanup",...cleanup}))}catch{cleanupFailed=true;console.log(JSON.stringify({stage:"http-life-cleanup",project:entry.project,status:"failed"}))}
    if(runtime)try{await closeDatabaseRuntime(runtime)}catch{cleanupFailed=true}
    console.log(JSON.stringify({stage:"http-life-closed",cleanupFailed,...httpChildFacts()}));clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);process.exitCode=1
  }
}
export async function httpLifecycle(){
  const original=await httpDevProof();let cases=0
  for(const mode of ["injected","after-http-sigterm","secret-sigterm"]){
    const child=ownedProcess(process.execPath,[filename,"--child",mode],{cwd:root,env:isolatedEnv(root),maxOutput:65536}),timer=setTimeout(()=>{void child.stop()},250000);let sent=false
    const wanted=mode==="secret-sigterm"?"http-secret-check":"http-life-request"
    if(mode!=="injected")child.child.stdout.on("data",()=>{if(!sent&&child.output.split("\n").some(line=>line.includes(`"stage":"${wanted}"`))){sent=true;child.child.kill("SIGTERM")}})
    child.child.stdin.end()
    try{
      const result=await child.done;check(result.code===1&&!result.stderr&&!result.overflow&&!result.spawnError)
      try{process.kill(child.child.pid,0);throw Error("C2_PARENT_RESIDUE")}catch(error){if(error.code!=="ESRCH")throw error}
      const rows=result.stdout.trim().split("\n").map(line=>JSON.parse(line)),registration=rows.find(x=>x.stage==="http-life-registered"),fixture=rows.find(x=>x.stage==="http-life-fixture"),failure=rows.find(x=>x.stage==="http-life-failure"),closed=rows.find(x=>x.stage==="http-life-closed"),cleanup=rows.find(x=>x.stage==="http-life-cleanup"),request=rows.find(x=>x.stage==="http-life-request")
      check(registration&&fixture&&failure?.category===(mode==="injected"?"C2_INJECTED":"C2_CANCELLED")&&closed?.active===0&&!closed.cleanupFailed&&cleanup?.status==="removed"&&cleanup.project===registration.project)
      if(mode==="secret-sigterm")check(sent&&failure.starts===0&&failure.secretSends===0&&closed.starts===0&&closed.secretSends===0&&!request)
      else{
        check(request?.status===404&&request.actualAjv&&closed.starts===1&&closed.secretSends===1)
        if(mode!=="injected")check(sent)
        try{process.kill(request.pid,0);throw Error("C2_JAVA_RESIDUE")}catch(error){if(error.code!=="ESRCH")throw error}
        const out=ownedProcess("/usr/sbin/lsof",["-nP",`-iTCP:${request.port}`,"-sTCP:LISTEN","-Fpn"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TZ:"UTC"},maxOutput:4096}),limit=setTimeout(()=>{void out.stop()},5000);out.child.stdin.end()
        try{const proof=await out.done;check(proof.code===1&&!proof.stdout&&!proof.stderr&&!proof.spawnError&&!proof.overflow)}finally{clearTimeout(limit);await out.stop()}
      }
      await httpAbsent(registration.project);await absentFile(registration.runtimeDirectory);await absentFile(fixture.directory)
      console.log(JSON.stringify({stage:"http-lifecycle-proof",mode,parentPid:child.child.pid,project:registration.project,...(request?{javaPid:request.pid,httpPort:request.port}:{}),signal:sent?"SIGTERM":"injected",javaStarts:closed.starts,secretSends:closed.secretSends,pidListenerProjectAndPrivateFilesAbsent:true}));cases++
    }finally{clearTimeout(timer);await child.stop()}
  }
  check(isDeepStrictEqual(original,await httpDevProof()));return {status:"verified",cases,originalDevSameHealthy:true}
}
if(process.argv[1]&&resolve(process.argv[1])===filename){
  try{if(process.argv.length===4&&process.argv[2]==="--child"&&["injected","after-http-sigterm","secret-sigterm"].includes(process.argv[3]))await childCase(process.argv[3]);else if(process.argv.length===2)console.log(JSON.stringify(await httpLifecycle()));else throw Error("C2_ARGUMENTS")}
  catch(error){console.log(JSON.stringify({status:"failed",category:/^C2_[A-Z_]+$/.test(error.message)?error.message:"IO"}));process.exitCode=1}
}
