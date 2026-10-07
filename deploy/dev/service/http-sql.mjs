import { ownedProcess } from "../process.mjs"
import { appPassword, active } from "./test-database.mjs"
import { currentHttpDatabase } from "./http-java.mjs"

const actions=new Set(["facts","expire","revoke-bot","restore-bot","disable-bot","enable-bot","pointer","receipt-body","receipt"]), children=new Set()
export async function stopHttpSqlChildren(){await Promise.all([...children].map(x=>x.stop()))}
export async function httpSql(runtime,entry,action,fixture={},signal){
  if(!actions.has(action))throw Error("C2_SQL_SELECTION")
  active(signal); const password=await appPassword(entry,signal); active(signal)
  const input=JSON.stringify({db:{mode:"local-dev",host:"127.0.0.1",port:entry.port,schema:"devclaw",user:"devclaw_app",password},fixture})
  await currentHttpDatabase(entry,signal); active(signal)
  const child=ownedProcess(runtime.java,["-Xmx256m","-Duser.timezone=UTC","-cp",runtime.classpath,"com.devclaw.botcontrol.http.HttpDatabaseProbe",action],{cwd:runtime.dir,env:runtime.env,maxOutput:1048576})
  children.add(child); const stop=()=>{void child.stop()},timer=setTimeout(stop,30000); signal?.addEventListener("abort",stop,{once:true}); if(signal?.aborted)stop()
  child.child.stdin.on("error",()=>{})
  try{
    await currentHttpDatabase(entry,signal); active(signal); child.child.stdin.end(input)
    const r=await child.done; active(signal)
    if(r.code!==0||r.stderr||r.spawnError||r.overflow||r.stdout.trim().split("\n").length!==1)throw Error("C2_SQL_BOUNDARY")
    const result=JSON.parse(r.stdout)
    if(result.status!=="verified")throw Error("C2_SQL_BOUNDARY")
    if(action==="facts" && (!/^[a-f0-9]{64}$/.test(result.factsSha256)||result.tables!==9||Object.keys(result.rows??{}).length!==9))throw Error("C2_SQL_BOUNDARY")
    return result
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",stop);await child.stop();children.delete(child)}
}
