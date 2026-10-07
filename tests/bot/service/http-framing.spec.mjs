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
