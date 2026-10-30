/** Client modules run in their own VM. No engine SDK, DOM, Node or ambient timers. */
export const CLIENT_BOOTSTRAP = String.raw`
(() => {
  const freeze=Object.freeze.bind(Object);
  const callbacks=new Map(), timers=new Map();
  let previous=new Map();
  let sequence=0, owner, state, props, columns=0, rows=0, dirty=false, message;
  let onKey, onPointer;
  function children(value,depth=0) {
    if(depth>24)throw Error("MODS_UI_DEPTH");
    const out=[];
    for(const child of Array.isArray(value)?value:[value]) {
      if(Array.isArray(child))out.push(...children(child,depth+1));
      else if(child!==null&&child!==undefined&&typeof child!=="boolean")
        out.push(typeof child==="number"?String(child):child);
      if(out.length>1000)throw Error("MODS_UI_NODES");
    }
    return out;
  }
  const elements=Object.create(null);
  for(const type of ["Box","Text","Button","Input","Select","Link","Code"]) {
    elements[type]=raw=>{
      const props={...raw}, nested=children(props.children), handlers={};
      delete props.children;
      for(const kind of ["onPress","onInput","onSubmit","onSelect"]){
        if(props[kind]!==undefined){
          if(typeof props[kind]!=="function")throw Error("MODS_UI_CALLBACK");
          handlers[kind]=props[kind]; delete props[kind];
        }
      }
      if(type==="Button"){
        if(props.label===undefined&&nested.length===1&&typeof nested[0]==="string")props.label=nested[0];
        if(props.key===undefined)props.key=props.label;
      }
      const node={type,props};
      if(["Box","Text","Link"].includes(type))node.children=nested;
      if(["Button","Input","Select"].includes(type)){
        const primary=type==="Button"?"onPress":type==="Input"?"onSubmit":"onSelect";
        if(!handlers[primary]||callbacks.size>=256)throw Error("MODS_UI_CALLBACK");
        const signature=JSON.stringify([type,props]);
        const handle=previous.get(signature)||++sequence;
        callbacks.set(handle,{handlers,key:props.key,signature});
        node.press={plugin:owner,handle};
      } else if(Object.keys(handlers).length)throw Error("MODS_UI_CALLBACK");
      return node;
    };
  }
  freeze(elements);
  const surface=freeze({
    elements,
    get state(){return state;}, get columns(){return columns;}, get rows(){return rows;},
    setState(value){state=value;dirty=true;},
    every(ms,fn){
      if(!Number.isFinite(ms)||ms<0||typeof fn!=="function"||timers.size>=16)
        throw Error("MODS_CLIENT_TIMER");
      const id=String(++sequence); timers.set(id,{ms,fn});return ()=>timers.delete(id);
    },
    onKey(fn){if(typeof fn!=="function")throw Error("MODS_CLIENT_KEY");onKey=fn;return()=>{if(onKey===fn)onKey=undefined;}},
    onPointer(fn){if(typeof fn!=="function")throw Error("MODS_CLIENT_POINTER");onPointer=fn;return()=>{if(onPointer===fn)onPointer=undefined;}},
    post(data){message=data;}
  });
  const sync=value=>{if(value&&typeof value.then==="function")throw Error("MODS_CLIENT_ASYNC");};
  globalThis.__cmbFunctionMod={register(on,options){
    owner=options.plugin;
    on("surface.update",(_,e)=>{
      dirty=false;message=undefined;
      if(e.kind==="render") {props=e.props;columns=e.columns;rows=e.rows;}
      else if(e.kind==="control") {
        const cb=callbacks.get(e.handle);
        if(!cb||cb.key!==e.event.element)throw Error("MODS_UI_STALE_ACTION");
        const fn=cb.handlers[e.callback];
        if(typeof fn!=="function"&&e.callback!=="onInput")throw Error("MODS_UI_CALLBACK");
        if(fn)sync(e.callback==="onPress"?fn(e.event):fn(e.event.value,e.event));
      } else if(e.kind==="key") {if(e.value.key!=="escape")sync(onKey?.(e.value));}
      else if(e.kind==="pointer")sync(onPointer?.(e.value));
      else if(e.kind==="tick")sync(timers.get(e.handle)?.fn());
      else if(e.kind!=="frame")throw Error("MODS_CLIENT_EVENT");
      previous=new Map([...callbacks].map(([handle,record])=>[record.signature,handle]));
      callbacks.clear();
      const module=globalThis.__cmbSurfaceMod;
      const names=Object.keys(module).filter(name=>/^[A-Z]/.test(name)&&typeof module[name]==="function");
      const draw=module.default||(names.length===1?module[names[0]]:undefined);
      if(typeof draw!=="function")throw Error("MODS_CLIENT_EXPORT");
      const tree=draw(props,surface);sync(tree);
      return {tree,dirty,...(message===undefined?{}:{message}),
        timers:[...timers].map(([id,t])=>({id,ms:t.ms}))};
    });
  }};
})();
`
