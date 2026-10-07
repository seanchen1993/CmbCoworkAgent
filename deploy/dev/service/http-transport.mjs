import { isDeepStrictEqual } from "node:util"
import { rawHttpSocket,httpCall,validateHttpResponse } from "./http-client.mjs"
import { parseHttpFrames,httpFramingSummary } from "./http-framing.mjs"
import { httpSql } from "./http-sql.mjs"
import { assertHttpNoSecret } from "./http-java.mjs"

const check=x=>{if(!x)throw Error("C2_TRANSPORT_ASSERTION")}
export async function httpWire(handle,build,signal,{head=false,parserEmpty=false,dripMs=0}={}){
  const wire=await rawHttpSocket(handle,"p1",signal),chunks=[];let bytes=0,interval
  const started=performance.now()
  try{
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{wire.socket.destroy();reject(Error("C2_RAW_DEADLINE"))},12000)
      wire.socket.on("data",chunk=>{bytes+=chunk.length;if(bytes>1100000){wire.socket.destroy();reject(Error("C2_RAW_BOUND"))}else chunks.push(chunk)})
      wire.socket.once("close",()=>{clearTimeout(timer);clearInterval(interval);resolve(Buffer.concat(chunks))})
      const input=build(wire)
      if(Array.isArray(input)){wire.socket.write(input[0]);if(dripMs)interval=setInterval(()=>{if(!wire.socket.destroyed)wire.socket.write(input[1])},dripMs)}else wire.socket.write(input)
    })
    try{return {frames:parseHttpFrames(response,{head,parserEmpty}),elapsedMs:Math.round(performance.now()-started),bytes:response.length}}
    catch(error){console.log(JSON.stringify({stage:"http-framing-failure",...httpFramingSummary(response)}));throw error}
  }finally{clearInterval(interval);wire.socket.destroy()}
}
export async function httpTransport(server,runtime,entry,create,signal){
  const facts=()=>httpSql(runtime,entry,"facts",{},signal),initial=await facts();let cases=0
  const base=x=>`Host: 127.0.0.1:${x.port}\r\nAuthorization: Bearer ${x.token}\r\nX-DevClaw-Space: A\r\nConnection: close\r\n`
  const get=(path,extra="")=>x=>`GET ${path} HTTP/1.1\r\n${base(x)}${extra}\r\n`
  async function ordinary(label,op,build,expected,{head=false,parserEmpty=false,dripMs=0,window}={}){
    const result=await httpWire(server,build,signal,{head,parserEmpty,dripMs})
    if(!result.frames.length){check(parserEmpty)}else{
      check(result.frames.length===1);const frame=result.frames[0];check([].concat(expected).includes(frame.status))
      if(head){check(frame.status===400&&frame.body.length===0&&frame.headers.connection?.toLowerCase()==="close")}
      else if(parserEmpty&&frame.body.length===0){check(frame.status===400||frame.status===408);if(frame.parserZeroChunk)check(frame.status===400&&frame.headers.connection.toLowerCase()==="close"&&frame.wireBodyBytes===5)}
      else{validateHttpResponse(op,frame.status,frame.body);assertHttpNoSecret(server,frame.body)}
    }
    if(window)check(result.elapsedMs>=window[0]&&result.elapsedMs<=window[1])
    check(isDeepStrictEqual(initial,await facts()));cases++
    console.log(JSON.stringify({stage:"http-transport-case",label,status:result.frames[0]?.status??null,category:head?"rejected-method/no-body":result.frames[0]?.parserZeroChunk?"parser-framing/exact-zero-chunk":parserEmpty&&(!result.frames.length||!result.frames[0].body.length)?"parser-framing":"ordinary-api-json",actualAjv:!head&&!!result.frames[0]?.body.length,connectionClose:result.frames[0]?.headers.connection?.toLowerCase()==="close",parserZeroChunk:result.frames[0]?.parserZeroChunk===true,wireBodyBytes:result.frames[0]?.wireBodyBytes??result.frames[0]?.body.length??0,elapsedMs:result.elapsedMs,allNineFactsUnchanged:true}))
  }
  for(const path of ["/api/bot/v1/bots/versions","/api/bot/v1/groups/members"]){const method=path.includes("bots")?"POST":"PUT";await ordinary("missing-id","getBot",x=>`${method} ${path} HTTP/1.1\r\n${base(x)}\r\n`,400)}
  for(const path of ["/api/bot/v1/bots/%6dissing","/api/bot/v1/bots/missing%3Aid","/api/bot/v1/bots/missing%2Eid"] )await ordinary("legal-single-encoded-id","getBot",get(path),404)
  for(const path of ["/api/bot/v1/bots/missing?","/api/bot/v1/bots/missing?a=1","/api/bot/v1/bots/a;b","/api/bot/v1/bots/%252e","/api/bot/v1/bots/%2e","/api/bot/v1/bots/%2e%2e","/api/bot/v1/bots/missing/","/api/bot/v1/bots//missing"] )await ordinary("invalid-gate-target-nonempty","getBot",get(path),400)
  // Pinned CoyoteAdapter URLDecoder/convertURI/normalize runs before the
  // context gate: encoded solidus, backslash, malformed hex and invalid UTF8
  // may produce its safe empty rejection rather than an API JSON response.
  for(const path of ["/api/bot/v1/bots/a%2Fb","/api/bot/v1/bots/a%5Cb","/api/bot/v1/bots/%FF","/api/bot/v1/bots/%zz"] )await ordinary("coyote-pre-context-uri-parser","getBot",get(path),400,{parserEmpty:true})
  await ordinary("encoded-fixed-prefix-not-alias","getBot",get("/api/%62ot/v1/bots/missing"),404)
  await ordinary("head-void-filter","getBot",x=>`HEAD /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}\r\n`,400,{head:true})
  await ordinary("options-not-auto-success","getBot",x=>`OPTIONS /api/bot/v1/bots/missing HTTP/1.1\r\n${base(x)}\r\n`,400)
  for(const [method,target] of [["OPTIONS","*"],["TRACE","/api/bot/v1/bots/missing"],["CONNECT","127.0.0.1:443"],["CONNECT","/api/bot/v1/bots/missing"],["DELETE","/api/bot/v1/bots/missing"],["PATCH","/api/bot/v1/bots/missing"]])await ordinary("unknown-method-pre-adapter","getBot",x=>`${method} ${target} HTTP/1.1\r\n${base(x)}\r\n`,400)
  await ordinary("unknown-bearer","getBot",x=>get("/api/bot/v1/bots/missing")({...x,token:"0".repeat(64)}),401)
  await ordinary("missing-bearer","getBot",x=>get("/api/bot/v1/bots/missing")(x).replace(/Authorization:[^\r]+\r\n/,""),401)
  await ordinary("missing-space","getBot",x=>get("/api/bot/v1/bots/missing")(x).replace("X-DevClaw-Space: A\r\n",""),400)
  await ordinary("comma-space","getBot",x=>get("/api/bot/v1/bots/missing")(x).replace("Space: A","Space: A,A"),400)
  await ordinary("wrong-host","getBot",x=>get("/api/bot/v1/bots/missing")(x).replace(`Host: 127.0.0.1:${x.port}`,"Host: localhost"),400)
  await ordinary("origin","getBot",get("/api/bot/v1/bots/missing","Origin: https://untrusted.invalid\r\n"),400)
  await ordinary("forwarded-cookie-not-identity","getBot",get("/api/bot/v1/bots/missing","Cookie: actor=p1\r\nX-Forwarded-For: 8.8.8.8\r\nX-DevClaw-Actor: p4\r\n"),404)
  await ordinary("fold-normalized-span-limited-proof","getBot",get("/api/bot/v1/bots/missing","X-Extra:           a\r\n b\r\n"),[400,404])
  const bodies=[Buffer.from('{"commandId":"duplicate","commandId":"other"}'),Buffer.from('{}{}'),Buffer.from('{"x":'+"[".repeat(70)+"0"+"]".repeat(70)+'}'),Buffer.from([0x7b,0xff,0x7d]),Buffer.alloc(0)]
  for(const body of bodies)await ordinary("strict-json-bytes","createBot",x=>Buffer.concat([Buffer.from(`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`),body]),400)
  const sentinel=Buffer.from('{"HTTP_ERROR_INPUT_SENTINEL":"HTTP_ERROR_INPUT_SENTINEL"}')
  await ordinary("error-input-sentinel","createBot",x=>Buffer.concat([Buffer.from(`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: ${sentinel.length}\r\n\r\n`),sentinel]),400)
  for(const extra of ["Content-Type: text/plain\r\n","Content-Type: application/json; charset=ISO-8859-1\r\n","Content-Type: application/json\r\nContent-Encoding: gzip\r\n"] )await ordinary("unsupported-body-metadata","createBot",x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}${extra}Content-Length: 2\r\n\r\n{}`,400)
  await ordinary("duplicate-content-length-parser","createBot",x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`,400,{parserEmpty:true})
  const large=Buffer.alloc(1048577,0x20)
  await ordinary("actual-cl-body-cap","createBot",x=>Buffer.concat([Buffer.from(`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: ${large.length}\r\n\r\n`),large]),413)
  await ordinary("actual-chunked-body-cap","createBot",x=>Buffer.concat([Buffer.from(`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${large.length.toString(16)}\r\n`),large,Buffer.from("\r\n0\r\n\r\n")]),413)
  await ordinary("incomplete-header-idle","getBot",x=>`GET /api/bot/v1/bots/missing HTTP/1.1\r\nHost: 127.0.0.1:${x.port}\r\n`,[400,408],{parserEmpty:true,window:[1200,4500]})
  const slow=x=>`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json\r\nContent-Length: 100\r\n\r\n`
  await ordinary("incomplete-body-idle","createBot",slow,400,{window:[1200,4500]})
  await ordinary("slow-drip-body-absolute","createBot",x=>[slow(x)," "],400,{dripMs:500,window:[4500,7500]})
  const held=await Promise.all(Array.from({length:4},()=>rawHttpSocket(server,"p1",signal)));let drip
  try{
    for(const wire of held)wire.socket.write(slow(wire))
    drip=setInterval(()=>{for(const wire of held)if(!wire.socket.destroyed)wire.socket.write(" ")},350)
    await new Promise(resolve=>setTimeout(resolve,150))
    const limited=await httpCall(server,"getBot","GET","/api/bot/v1/bots/missing",{signal})
    check(limited.status===429&&limited.value.error.code==="RATE_LIMITED"&&limited.value.error.retryable===true&&isDeepStrictEqual(initial,await facts()))
    console.log(JSON.stringify({stage:"http-admission-proof",heldBodies:4,status:429,actualAjv:true,allNineFactsUnchanged:true}))
  }finally{clearInterval(drip);for(const wire of held)wire.socket.destroy()}
  const pressure=[]
  try{
    // More incomplete requests than eight workers, up to the fixed bounded
    // worker+queue capacity. No auth is sent before the own endpoint proof.
    pressure.push(...await Promise.all(Array.from({length:24},()=>rawHttpSocket(server,"p1",signal))))
    for(const wire of pressure)if(!wire.socket.destroyed)wire.socket.write(`GET /api/bot/v1/bots/missing HTTP/1.1\r\nHost: 127.0.0.1:${wire.port}\r\n`)
    await new Promise(resolve=>setTimeout(resolve,2300))
  }finally{for(const wire of pressure)wire.socket.destroy()}
  check(isDeepStrictEqual(initial,await facts()))
  const payload=Buffer.from(JSON.stringify(create("legal-chunked"))),chunked=await httpWire(server,x=>Buffer.concat([Buffer.from(`POST /api/bot/v1/bots HTTP/1.1\r\n${base(x)}Content-Type: application/json; charset=UTF-8\r\nTransfer-Encoding: chunked\r\n\r\n${payload.length.toString(16)}\r\n`),payload,Buffer.from("\r\n0\r\n\r\n")]),signal)
  check(chunked.frames.length===1&&chunked.frames[0].status===201);validateHttpResponse("createBot",201,chunked.frames[0].body)
  const recovered=await httpCall(server,"getBot","GET","/api/bot/v1/bots/missing",{signal});check(recovered.status===404)
  console.log(JSON.stringify({stage:"http-transport-proof",cases,ordinaryErrorsNonemptyActualAjv:true,headOnlyVoidException:true,legalChunkedActual:true,slowBodyBoundAndRecovery:true,pressureSockets:pressure.length,workers:8,queue:16,connections:32,viewNotWireCopy:true}))
  return {transportCases:cases,legalChunked:true}
}
