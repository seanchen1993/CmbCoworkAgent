import http from "node:http"
import net from "node:net"
import { httpBearer, proveHttpEndpoint,assertHttpNoSecret } from "./http-java.mjs"
import { active } from "./test-database.mjs"
import { operationDefinitions, dereference, validateRef } from "../../../tests/bot/schema-support.mjs"

const selectedOperations = new Set(["createBot","getBot","createBotVersion","createGroup","getGroup","updateGroupMembers","createTask","getTask","createTaskMessage","getEvents"])
export function validateHttpResponse(operation,status,body) {
  if (!selectedOperations.has(operation)) throw Error("C2_OPERATION_SELECTION")
  const op = operationDefinitions.find(x => x.operation.operationId === operation)?.operation, response = op?.responses[String(status)]
  const schema = response && dereference(response).content?.["application/json"]?.schema
  if (!schema || !Buffer.isBuffer(body) || !body.length || body.length > 1048576) throw Error("C2_RESPONSE_SCHEMA")
  let value; try { value = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body)) } catch { throw Error("C2_RESPONSE_SCHEMA") }
  if (!validateRef(schema,value).valid) throw Error("C2_RESPONSE_SCHEMA")
  return value
}
export async function httpCall(handle,operation,method,path,{ principal="p1",space="A",body,headers={},signal }={}) {
  const token = await httpBearer(handle,principal,signal), endpoint = await proveHttpEndpoint(handle,signal); active(signal)
  const bytes = body == null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return new Promise((resolve,reject) => {
    let settled = false, deadline; const finish = (error,result) => { if(settled)return; settled=true; clearTimeout(deadline); signal?.removeEventListener("abort",abort); error ? reject(error) : resolve(result) }
    const request = http.request({ host:"127.0.0.1",port:endpoint.port,method,path,agent:false,headers:{Authorization:`Bearer ${token}`,"X-DevClaw-Space":space,...(bytes ? {"Content-Type":"application/json","Content-Length":bytes.length} : {}),...headers} },response => {
      let size=0; const chunks=[]
      response.on("data",chunk => { size+=chunk.length; if(size>1048576)request.destroy(Error("C2_RESPONSE_SIZE")); else chunks.push(chunk) })
      response.on("end",() => { try { const body=Buffer.concat(chunks); if(response.statusCode>=400)assertHttpNoSecret(handle,body); const value=validateHttpResponse(operation,response.statusCode,body); if(response.headers["cache-control"] !== "no-store" || response.headers["x-content-type-options"] !== "nosniff" || Number(response.headers["content-length"]) !== body.length || response.headers["set-cookie"] || response.headers["access-control-allow-origin"])throw Error("C2_RESPONSE_HEADERS"); finish(null,{status:response.statusCode,body,value,headers:response.headers}) } catch(error){finish(error)} })
      response.on("error",() => finish(Error("C2_HTTP_RESPONSE")))
      response.on("aborted",() => finish(Error("C2_HTTP_RESPONSE")))
    })
    const abort=()=>request.destroy(Error("C2_CANCELLED")); signal?.addEventListener("abort",abort,{once:true}); if(signal?.aborted)abort()
    request.setTimeout(10000,()=>request.destroy(Error("C2_HTTP_TIMEOUT")))
    deadline=setTimeout(()=>request.destroy(Error("C2_HTTP_TIMEOUT")),10000)
    request.on("error",()=>finish(Error("C2_HTTP_REQUEST"))); request.end(bytes)
  })
}
// Own listener/token proof precedes raw transport too. Caller receives only this
// bounded connected socket, never a configurable endpoint or stale-ready alias.
export async function rawHttpSocket(handle,principal,signal) {
  const token = await httpBearer(handle,principal,signal), endpoint = await proveHttpEndpoint(handle,signal); active(signal)
  const socket = net.createConnection({host:"127.0.0.1",port:endpoint.port})
  socket.setTimeout(12000,()=>socket.destroy())
  const abort=()=>socket.destroy(); signal?.addEventListener("abort",abort,{once:true}); if(signal?.aborted)abort()
  socket.once("close",()=>signal?.removeEventListener("abort",abort)); socket.on("error",()=>{})
  await new Promise((resolve,reject)=>{
    let settled=false
    const cleanup=()=>{clearTimeout(timer);socket.removeListener("connect",connected);socket.removeListener("error",failed);socket.removeListener("close",failed);signal?.removeEventListener("abort",failed)}
    const complete=(error)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve()}
    const connected=()=>complete(),failed=()=>complete(Error("C2_RAW_CONNECT")),timer=setTimeout(()=>{socket.destroy();failed()},5000)
    socket.once("connect",connected);socket.once("error",failed);socket.once("close",failed);signal?.addEventListener("abort",failed,{once:true});if(signal?.aborted)failed()
  })
  active(signal); return {socket,token,...endpoint}
}
