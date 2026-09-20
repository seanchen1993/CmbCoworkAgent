/** Client code executes in a separate VM. Its only outputs are trees and messages. */
export const SURFACE_BOOTSTRAP = String.raw`
(() => {
  const define=Object.defineProperty.bind(Object);
  const freeze=Object.freeze.bind(Object);
  const callbacks=new Map();
  const timers=new Map();
  let serial=0;
  let state;
  let props;
  let columns=0,rows=0;
  let dirty=false;
  let message;
  let onKey,onPointer;
  const elements=Object.create(null);
  function children(values,depth=0) {
    if(depth>32) throw Error("MODS_UI_DEPTH");
    const out=[];
    for(const value of values) {
      if(Array.isArray(value)) out.push(...children(value,depth+1));
      else if(value!==null && value!==undefined && value!==false && value!==true)
        out.push(typeof value === "number" ? String(value) : value);
      if(out.length>2000) throw Error("MODS_UI_NODES");
    }
    return out;
  }
  for(const name of ["Box","Text","Button","Input","Select","Link","Code"]) {
    elements[name]=input=>{
      const value=input||{};
      const data={};
      for(const [key,item] of Object.entries(value)) {
        if(key==="children") continue;
        if(["onPress","onInput","onSelect","onEvent"].includes(key)) {
          if(typeof item!=="function") throw Error("MODS_UI_HANDLER");
          if(callbacks.size>=256) throw Error("MODS_UI_CALLBACK_LIMIT");
          const handle=String(++serial);
          callbacks.set(handle,item);
          data[key]=handle;
        } else if(typeof item === "function" || ["__proto__","constructor","prototype"].includes(key))
          throw Error("MODS_UI_PROP");
        else data[key]=item;
      }
      return freeze({type:name,props:freeze(data),children:freeze(children([value.children]))});
    };
  }
  freeze(elements);
  const surface=freeze({
    elements,
    get state(){return state;},
    get columns(){return columns;},
    get rows(){return rows;},
    setState(value){state=value;dirty=true;},
    every(ms,fn){
      if(!Number.isFinite(ms)||ms<0||typeof fn!=="function"||timers.size>=16) throw Error("MODS_UI_TIMER");
      const id=String(++serial);
      timers.set(id,{ms,fn});
      return ()=>timers.delete(id);
    },
    onKey(fn){onKey=fn;return ()=>{if(onKey===fn)onKey=undefined;}},
    onPointer(fn){onPointer=fn;return ()=>{if(onPointer===fn)onPointer=undefined;}},
    post(data){message=data;}
  });
  define(globalThis,"h",{value:(tag,input,...nested)=>{
    if(typeof tag!=="function")throw Error("MODS_UI_TAG");
    return tag({...input,children:nested.length?nested:input?.children});
  }});
  define(globalThis,"Fragment",{value:input=>elements.Box(input)});
  define(globalThis,"__cmbFunctionMod",{value:{register(on){
    on("surface.update",($,e)=>{
      message=undefined;
      dirty=false;
      if(e.kind==="render") {props=e.props;columns=e.columns;rows=e.rows;}
      else if(e.kind==="press") {
        const fn=callbacks.get(e.handle);
        if(!fn)throw Error("MODS_UI_STALE_HANDLE");
        fn(e.value);
      } else if(e.kind==="key") {if(e.value.key!=="escape")onKey?.(e.value);}
      else if(e.kind==="pointer")onPointer?.(e.value);
      else if(e.kind==="tick")timers.get(e.handle)?.fn();
      else throw Error("MODS_UI_EVENT");
      callbacks.clear();
      const module=globalThis.__cmbSurfaceMod;
      const draw=module.default;
      if(typeof draw!=="function")throw Error("MODS_CLIENT_EXPORT");
      const tree=draw(props,surface);
      if(tree && typeof tree.then==="function")throw Error("MODS_CLIENT_ASYNC");
      return {tree,dirty,...(message===undefined?{}:{message}),
        timers:[...timers].map(([id,t])=>({id,ms:t.ms}))};
    });
  }}});
})();
`
