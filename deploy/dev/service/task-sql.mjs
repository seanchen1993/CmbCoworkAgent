import { ownedProcess } from "../process.mjs"
import { appPassword, active } from "./test-database.mjs"
import { currentHttpDatabase } from "./http-java.mjs"
const actions=new Set(["facts","legacy","v1","expire-cursor","expire-command","receipt"]), children=new Set()
export async function stopTaskSqlChildren(){const results=await Promise.allSettled([...children].map(child=>child.stop()));if(results.some(x=>x.status!=="fulfilled"))throw Error("B02_SQL_CLEANUP")}
export async function taskSql(runtime,entry,action,fixture={},signal){
  if(!actions.has(action))throw Error("B02_SQL_SELECTION")
  active(signal);await currentHttpDatabase(entry,signal);active(signal);const password=await appPassword(entry,signal);active(signal)
  const input=JSON.stringify({db:{mode:"local-dev",host:"127.0.0.1",port:entry.port,schema:"devclaw",user:"devclaw_app",password},fixture})
  await currentHttpDatabase(entry,signal);active(signal)
  const child=ownedProcess(runtime.java,["-Xmx256m","-Duser.timezone=UTC","-cp",runtime.classpath,"com.devclaw.botcontrol.persistence.TaskDatabaseProbe",action],{cwd:runtime.dir,env:runtime.env,maxOutput:65536});children.add(child)
  const stop=()=>{void child.stop()},timer=setTimeout(stop,45000);signal?.addEventListener("abort",stop,{once:true});if(signal?.aborted)stop();child.child.stdin.on("error",()=>{})
  try{await currentHttpDatabase(entry,signal);active(signal);child.child.stdin.end(input);const result=await child.done;active(signal)
    if(result.code!==0||result.stderr||result.spawnError||result.overflow||result.stdout.trim().split("\n").length!==1)throw Error("B02_SQL_BOUNDARY")
    const proof=JSON.parse(result.stdout);if(proof.status!=="verified")throw Error("B02_SQL_BOUNDARY")
    if(["facts","legacy"].includes(action)&&(!/^[a-f0-9]{64}$/.test(proof.factsSha256)||proof.tables!==(action==="facts"?16:9)||Object.keys(proof.rows??{}).length!==proof.tables))throw Error("B02_SQL_BOUNDARY")
    return proof
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",stop);await child.stop();try{process.kill(child.child.pid,0);throw Error("B02_SQL_RESIDUE")}catch(error){if(error.code!=="ESRCH")throw error}children.delete(child)}
}
