/** Private generator cursors. Advancing a cursor always borrows only its current pull frame. */
export const FUNCTION_STREAM_CURSORS = String.raw`
  const streamCursors = new Map();
  let streamCursorSequence = 0;
  // A module may discard its own cursor. Cross-plugin isolation relies on the VM, not this name.
  define(globalThis,"__functionReleaseStreamCursor",{value:id=>streamCursors.delete(id)});
  function allocateStreamCursor(meta, scope) {
    if(streamCursors.size>=32)throw Error("MODS_STREAM_CURSOR_LIMIT");
    const id=++streamCursorSequence;
    const record={plugin:meta.plugin.name,event:meta.event,body:undefined,busy:false};
    streamCursors.set(id,record);scope.cursorId=id;
    return {id,record};
  }
  function streamCursorScope(id, plugin) {
    const current=asyncScope,record=streamCursors.get(id);
    if(!record||!record.busy||!current||current.cursorId!==id||current.plugin!==plugin)
      throw Error("MODS_STALE_STREAM_PULL");
    return current;
  }
  async function advanceStreamCursor(meta,scope) {
    const {id,action}=meta.streamCursor,record=streamCursors.get(id);
    if(!record||record.plugin!==meta.plugin.name||record.event!==meta.event)
      throw Error("MODS_STREAM_CURSOR_MISSING");
    if(record.busy)throw Error("MODS_STREAM_CURSOR_BUSY");
    if(action!=="next"&&action!=="return")throw Error("MODS_STREAM_CURSOR_ACTION");
    scope.cursorId=id;record.busy=true;
    try {
      const item=await inScope(scope,()=>record.body[action]());
      if(!item||typeof item!=="object")throw Error("MODS_STREAM_CURSOR_RESULT");
      if(item.done||action==="return")streamCursors.delete(id);
      return item.value===undefined?{done:!!item.done}:{done:!!item.done,value:item.value};
    }catch(error){streamCursors.delete(id);throw error}
    finally{record.busy=false}
  }
`
