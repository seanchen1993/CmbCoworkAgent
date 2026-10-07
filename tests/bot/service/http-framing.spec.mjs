import { test } from "node:test"
import assert from "node:assert/strict"
import { parseHttpFrames } from "../../../deploy/dev/service/http-framing.mjs"
const frame=body=>Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: application/json\r\n\r\n${body}`)
test("HTTP pipeline consumes exactly length-delimited frames including body HTTP sentinel",()=>{
  const first=frame('"HTTP/1.1 404 fake-in-body"'),second=frame('{}'),result=parseHttpFrames(Buffer.concat([first,second]))
  assert.equal(result.length,2);assert.equal(result[0].body.toString(),'"HTTP/1.1 404 fake-in-body"');assert.equal(result[1].body.toString(),'{}')
  for(const bad of [Buffer.concat([first,second,Buffer.from("extra")]),second.subarray(0,second.length-1),Buffer.from("HTTP/1.1 404 fake"),Buffer.from("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}")])assert.throws(()=>parseHttpFrames(bad),/C2_RAW_FRAMING/)
})
test("safe parser empty close is explicit and never a normal schema body",()=>{
  assert.throws(()=>parseHttpFrames(Buffer.alloc(0)),/C2_RAW_FRAMING/);assert.deepEqual(parseHttpFrames(Buffer.alloc(0),{parserEmpty:true}),[])
  const empty=Buffer.from("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  assert.throws(()=>parseHttpFrames(empty),/C2_RAW_FRAMING/);assert.equal(parseHttpFrames(empty,{parserEmpty:true})[0].body.length,0)
})
test("only a sole closing parser 400 consumes the exact five-byte zero chunk",()=>{
  const response=({status=400,te="chunked",connection="close",extra="",tail="0\r\n\r\n"}={})=>Buffer.from(`HTTP/1.1 ${status} Rejected\r\nTransfer-Encoding: ${te}\r\n${connection===null?"":`Connection: ${connection}\r\n`}${extra}\r\n${tail}`)
  const valid=response(),parsed=parseHttpFrames(valid,{parserEmpty:true})
  assert.equal(parsed.length,1);assert.equal(parsed[0].status,400);assert.equal(parsed[0].body.length,0);assert.equal(parsed[0].wireBodyBytes,5);assert.equal(parsed[0].parserZeroChunk,true)
  assert.equal(parseHttpFrames(response({te:" \tChUnKeD \t"}),{parserEmpty:true})[0].parserZeroChunk,true)
  assert.throws(()=>parseHttpFrames(valid),/C2_RAW_FRAMING/)
  assert.throws(()=>parseHttpFrames(valid,{head:true,parserEmpty:true}),/C2_RAW_FRAMING/)
  const bad=[response({status:408}),response({status:200}),response({te:"gzip"}),response({te:"chunked, chunked"}),response({extra:"Content-Length: 0\r\n"}),response({connection:"keep-alive"}),response({connection:null}),response({tail:"0;x=1\r\n\r\n"}),response({tail:"0\r\nX-Trailer: x\r\n\r\n"}),response({tail:"1\r\nx\r\n0\r\n\r\n"}),response({tail:"0\r\n\r"}),response({tail:""}),Buffer.concat([valid,frame("{}")]),Buffer.concat([frame("{}"),valid]),Buffer.concat([valid,Buffer.from("extra")]),response({extra:"Transfer-Encoding: chunked\r\n"}),response({extra:"Set-Cookie: x=y\r\n"}),response({extra:"Access-Control-Allow-Origin: *\r\n"})]
  for(const bytes of bad)assert.throws(()=>parseHttpFrames(bytes,{parserEmpty:true}),/C2_RAW_FRAMING/)
})
