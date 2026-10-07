// Response parsing for the real TCP probe; no substring success predicates.
export function httpFramingSummary(bytes){
  const end=bytes.indexOf("\r\n\r\n"),header=end>=0?bytes.subarray(0,end).toString("latin1"):"",body=end>=0?bytes.subarray(end+4):Buffer.alloc(0)
  const status=/^HTTP\/1\.[01] ([0-9]{3}) /.exec(header)?.[1],cl=/\r\ncontent-length:\s*([0-9]+)\s*(?:\r\n|$)/i.exec(header)?.[1],te=/\r\ntransfer-encoding:\s*([^\r\n]+)(?:\r\n|$)/i.exec(header)?.[1]
  return {bytes:bytes.length,status:status?Number(status):null,headerBytes:end<0?null:end+4,contentLength:cl?Number(cl):null,transferEncoding:te?te.toLowerCase().trim()==="chunked"?"chunked":"other":null,wireBodyBytes:body.length,exactZeroChunk:body.equals(Buffer.from("0\r\n\r\n")),containsHTML:body.toString("utf8").toLowerCase().includes("<html")}
}
export function parseHttpFrames(bytes,{head=false,parserEmpty=false}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length>1100000)throw Error("C2_RAW_FRAMING")
  if(!bytes.length){if(parserEmpty)return [];throw Error("C2_RAW_FRAMING")}
  const frames=[];let offset=0
  while(offset<bytes.length){
    const end=bytes.indexOf("\r\n\r\n",offset)
    if(end<0||end-offset>8192)throw Error("C2_RAW_FRAMING")
    const lines=bytes.subarray(offset,end).toString("latin1").split("\r\n"),match=/^HTTP\/1\.[01] ([0-9]{3}) [^\r\n]*$/.exec(lines.shift())
    if(!match)throw Error("C2_RAW_FRAMING")
    const headers={}
    for(const line of lines){const colon=line.indexOf(":");if(colon<1)throw Error("C2_RAW_FRAMING");const name=line.slice(0,colon).toLowerCase(),value=line.slice(colon+1).trim();if(Object.hasOwn(headers,name))throw Error("C2_RAW_FRAMING");headers[name]=value}
    if(headers["set-cookie"]||headers["access-control-allow-origin"])throw Error("C2_RAW_FRAMING")
    let length
    if(head)length=0
    else if(/^(0|[1-9][0-9]*)$/.test(headers["content-length"]??""))length=Number(headers["content-length"])
    else if(parserEmpty&&offset===0&&end+4===bytes.length)length=0
    else throw Error("C2_RAW_FRAMING")
    if(headers["transfer-encoding"]||length>1048576||end+4+length>bytes.length)throw Error("C2_RAW_FRAMING")
    const body=bytes.subarray(end+4,end+4+length)
    if(body.toString("utf8").toLowerCase().includes("<html"))throw Error("C2_RAW_FRAMING")
    frames.push({status:Number(match[1]),headers,body});offset=end+4+length
    if(head&&offset!==bytes.length)throw Error("C2_RAW_FRAMING")
  }
  return frames
}
