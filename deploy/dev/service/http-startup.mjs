import { chmod,lstat } from "node:fs/promises"
import { ownedProcess } from "../process.mjs"
import { active,appPassword,testResources } from "./test-database.mjs"
import { readHttpIdentity,checkHttpFixture } from "./http-fixture.mjs"
import { currentHttpDatabase,startHttpJava,httpChildFacts } from "./http-java.mjs"
import { hostState,daemon,docker } from "../docker/host.mjs"

const check=x=>{if(!x)throw Error("C2_STARTUP_ASSERTION")},children=new Set()
export async function stopHttpStartupChildren(){await Promise.all([...children].map(x=>x.stop()))}
async function ownPorts(pid){
  const child=ownedProcess("/usr/sbin/lsof",["-nP","-a","-p",String(pid),"-iTCP","-sTCP:LISTEN","-Fpn"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TZ:"UTC"},maxOutput:4096}),timer=setTimeout(()=>{void child.stop()},5000);child.child.stdin.end()
  try{const r=await child.done;if(r.code===1&&!r.stdout&&!r.stderr)return [];check(r.code===0&&!r.stderr&&!r.overflow&&!r.spawnError);check(r.stdout.trim().split("\n").filter(x=>x.startsWith("p")).join()===`p${pid}`);return r.stdout.split("\n").filter(x=>x.startsWith("n"))}finally{clearTimeout(timer);await child.stop()}
}
async function rejected(runtime,entry,fixture,label,transform,signal){
  active(signal);await currentHttpDatabase(entry,signal);await checkHttpFixture(fixture,signal);active(signal)
  const password=await appPassword(entry,signal);active(signal);const identity=await readHttpIdentity(fixture,signal)
  const config={mode:"local-dev",http:{host:"127.0.0.1",port:0},db:{mode:"local-dev",host:"127.0.0.1",port:entry.port,schema:"devclaw",user:"devclaw_app",password},identity}
  const bytes=transform(config);check(Buffer.isBuffer(bytes));await currentHttpDatabase(entry,signal);await checkHttpFixture(fixture,signal);active(signal)
  const child=ownedProcess(runtime.java,["-Xmx256m","-Duser.timezone=UTC","-cp",runtime.classpath,"com.devclaw.botcontrol.http.LocalHttpMain"],{cwd:runtime.dir,env:runtime.env,maxOutput:8192});children.add(child)
  const cancel=()=>{void child.stop()},timer=setTimeout(cancel,35000);signal?.addEventListener("abort",cancel,{once:true});let probes=0
  try{
    await currentHttpDatabase(entry,signal);await checkHttpFixture(fixture,signal);active(signal);child.child.stdin.on("error",()=>{});child.child.stdin.end(bytes)
    while(!child.exited){check((await ownPorts(child.child.pid)).length===0);probes++;await new Promise(resolve=>setTimeout(resolve,30));active(signal)}
    const result=await child.done;check(result.code===1&&!result.stderr&&!result.spawnError&&!result.overflow&&result.stdout.trim()==='{"status":"failed","reason":"HTTP_STARTUP"}'&&probes>0)
    for(const secret of [password,...identity.bearers.map(x=>x.token)])check(!result.stdout.includes(secret)&&!result.stderr.includes(secret))
    console.log(JSON.stringify({stage:"http-startup-negative",label,pid:child.child.pid,exit:1,actualOwnListenerSnapshots:probes,listenerCount:0,safeFixedError:true,actualSecretsNotEchoed:true}))
  }finally{
    clearTimeout(timer);signal?.removeEventListener("abort",cancel);await child.stop();await child.done;children.delete(child)
    try{process.kill(child.child.pid,0);throw Error("C2_JAVA_RESIDUE")}catch(error){if(error.code!=="ESRCH")throw error}
  }
}
export async function httpStartup(runtime,entry,fixture,signal,{unmigrated=false}={}){
  const encode=x=>Buffer.from(JSON.stringify(x))
  if(unmigrated){await rejected(runtime,entry,fixture,"missing-migration",encode,signal);return 1}
  const cases=[
    ["non-local-mode",x=>encode({...x,mode:"production"})],
    ["non-loopback-http",x=>encode({...x,http:{host:"0.0.0.0",port:0}})],
    ["unknown-config",x=>encode({...x,unknown:true})],
    ["missing-identity",x=>{delete x.identity;return encode(x)}],
    ["duplicate-config",x=>Buffer.from(JSON.stringify(x).replace('"mode":"local-dev"','"mode":"local-dev","mode":"local-dev"'))],
    ["trailing-document",x=>Buffer.concat([encode(x),Buffer.from("{}")])],
    ["bad-utf8",()=>Buffer.from([0xc0,0xaf])],
    ["wrong-password",x=>encode({...x,db:{...x.db,password:"0".repeat(64)}})]
  ]
  for(const [label,transform] of cases)await rejected(runtime,entry,fixture,label,transform,signal)
  const counts=httpChildFacts();await chmod(fixture.file,0o644)
  try{let refused=false;try{await startHttpJava(runtime,entry,fixture,"production",signal)}catch{refused=true}check(refused&&JSON.stringify(httpChildFacts())===JSON.stringify(counts))}
  finally{await chmod(fixture.file,0o600);await checkHttpFixture(fixture,signal)}
  console.log(JSON.stringify({stage:"http-startup-metadata",wideFileRefused:true,newHttpJavaStarts:0,newSecretSends:0,inode:(await lstat(fixture.file)).ino}))
  return cases.length+1
}
export async function httpOffline(entry,runtime,fixture,signal){
  await currentHttpDatabase(entry,signal);const proof=await testResources(entry,signal,true),state=await hostState();await daemon(state);active(signal)
  check(proof.containers.length===1&&proof.containers[0].Id===entry.container)
  await docker(state,["stop","--time","5",entry.container],{stdoutOnly:true,signal})
  const counts=httpChildFacts();let refused=false
  try{await startHttpJava(runtime,entry,fixture,"production",signal)}catch{refused=true}
  check(refused&&JSON.stringify(httpChildFacts())===JSON.stringify(counts));console.log(JSON.stringify({stage:"http-offline-owned-db",project:entry.project,currentReadyRefused:true,newJavaStarts:0,newSecretSends:0}))
}
