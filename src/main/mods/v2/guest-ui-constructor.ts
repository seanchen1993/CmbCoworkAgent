/** Trusted bootstrap only. Host captures this helper and removes its global before plugin eval. */
export const FUNCTION_UI_CONSTRUCTOR_BOOTSTRAP = String.raw`
  const constructorActions = new WeakMap();
  const resolverScopes = new Map();
  const constructorTables = new Map();
  const constructorDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
  const constructorArray = Array.isArray.bind(Array);
  const constructorCreate = Object.create.bind(Object);
  const constructorApply = Reflect.apply.bind(Reflect);
  const constructorMapGet = Map.prototype.get;
  const constructorMapSet = Map.prototype.set;
  const constructorWeakGet = WeakMap.prototype.get;
  const constructorWeakSet = WeakMap.prototype.set;
  const constructorCallbackNames = ["onPress", "onInput", "onSubmit", "onSelect", "onLinkPress"];
  function constructorScope(token) {
    const scope = {
      uiConstructor: token, event: "ui.resolve", ended: false, background: false,
      unawaited: [], promptAdmissions: [],
      call: (method, args, callSignal) => {
        try {
        const state=callSignal===undefined?undefined:makeFunctionSignal.read(callSignal);
        if(state?.aborted)throw state.reason;
        const cancelId=state?String(++cancelCallSequence):undefined;
        const pending=constructorHost(scope.uiConstructor,method,pack(args),cancelId);
        const detach=state?makeFunctionSignal.subscribe(callSignal,
          ()=>cancelHostCall(scope.uiConstructor,cancelId)):()=>{};
        // Only trusted reply decoding runs here. A closed constructor must reject this
        // actual Promise without requiring an expired guest generator to resume.
        return nativeThen.call(pending, text => {
          try {
            const reply = parse(text);
            if (reply.error) {
              const error = Error(reply.error.message);
              define(error, "code", { value: reply.error.code });
              throw error;
            }
            return frozen(reply.value);
          } finally {detach();}
        }, error => {detach();throw error;});
        } catch (error) {return new NativePromise((resolve,reject)=>reject(error));}
      }
    };
    return scope;
  }
  function constructorResolve(meta, input, event) {
    if (!input || input.surface !== "desktop" || typeof input.component !== "string")
      throw Error("MODS_UI_SURFACE_UNAVAILABLE");
    const table = constructorReadTable(input.component);
    if (table === undefined) return uiElements(meta, input);
    const keys=ownKeys(input);
    if(keys.some(key=>key!=="surface"&&key!=="component")){
      const scope=asyncScope;
      if(!scope||scope.event!=="ui.render"||!scope.uiGeneration||
          scope.plugin!==meta.plugin.name||scope.requestId!==input.requestId||
          scope.component!==input.component||!event||
          keys.some(key=>!ownKeys(event).includes(key)))
        throw Error("MODS_UI_SURFACE_UNAVAILABLE");
    }
    return table;
  }
  function constructorScopedCall(meta, method, args, callSignal) {
    const current = asyncScope;
    if (!current?.uiConstructor) return undefined;
    if (callSignal !== undefined) {
      const state = makeFunctionSignal.read(callSignal);
      if (state?.aborted) return Promise.reject(state.reason);
    }
    return current.call(method, args, callSignal);
  }
  function constructorCapture(props) {
    const manifest = new Map();
    let nodes = 0;
    function visit(tree, path, depth) {
      if (++nodes > 1000 || depth > 24) throw Error("MODS_UI_NODES");
      if (!tree || typeof tree !== "object") return;
      if (constructorArray(tree)) {
        for (let i = 0; i < tree.length; i++) visit(tree[i], path + "/" + i, depth + 1);
        return;
      }
      const d = constructorDescriptors(tree);
      for (const key of ownKeys(d)) if (!("value" in d[key])) throw Error("MODS_UI_RESOLVE_DATA");
      const type = d.type?.value;
      const p = d.props?.value;
      const pd = p && typeof p === "object" ? constructorDescriptors(p) : {};
      for (const key of ownKeys(pd)) if (!("value" in pd[key])) throw Error("MODS_UI_RESOLVE_DATA");
      const press = d.press?.value, client = d.client?.value;
      if (press || client) constructorApply(constructorMapSet, manifest,
        [path, { type, key: pd.key?.value, press, client }]);
      const children = d.children?.value;
      if (constructorArray(children)) visit(children, path + "/children", depth + 1);
    }
    const descriptors = constructorDescriptors(props || {});
    for (const key of ownKeys(descriptors))
      if (!("value" in descriptors[key])) throw Error("MODS_UI_RESOLVE_DATA");
    if (descriptors.children) visit(descriptors.children.value, "children", 0);
    const token = freeze({});
    constructorApply(constructorWeakSet,constructorActions,
      [token,{manifest,module:descriptors.module?.value}]);
    return token;
  }
  function constructorReconnect(input) {
    const originalGraph = constructorApply(constructorWeakGet,constructorActions,[input.actions]);
    if (!originalGraph) throw Error("MODS_UI_RESOLVE_ACTIONS");
    const manifest = originalGraph.manifest;
    const scope = asyncScope;
    if (!scope || !scope.uiGeneration || scope.event !== "ui.render")
      throw Error("MODS_UI_RENDER_ENDED");
    let nodes = 0;
    let rootMatches = 0;
    const actionKinds = { Button: "onPress", Input: "onSubmit", Select: "onSelect", Markdown: "onLinkPress" };
    function clone(tree, path, depth) {
      if (++nodes > 1000 || depth > 24) throw Error("MODS_UI_NODES");
      if (typeof tree === "string") return tree;
      if (!tree || typeof tree !== "object" || constructorArray(tree))
        throw Error("MODS_UI_RESOLVE_TREE");
      const result = { ...tree };
      delete result.press;
      delete result.client;
      if (tree.type === "engine") return frozen(result);
      if (tree.type === "fragment") {
        if (ownKeys(tree).some(key => key !== "type" && key !== "children"))
          throw Error("MODS_UI_RESOLVE_TREE");
      } else {
        result.props = { ...tree.props };
        for (const key of constructorCallbackNames)
          delete result.props[key];
      }
      const original = constructorApply(constructorMapGet,manifest,[path]);
      if (original && original.type === result.type && original.key === result.props?.key) {
        if (original.press) result.press = original.press;
        if (original.client) result.client = original.client;
      }
      const kind = actionKinds[result.type];
      const rootMatch=input.name===result.type&&input.key===result.props?.key&&
        ((kind&&typeof input.callbacks[kind]==="function")||
          (result.type==="Client"&&originalGraph.module===result.props?.module));
      if(rootMatch&&++rootMatches>1)throw Error("MODS_UI_ACTION_OWNER");
      if (!result.press && rootMatch && kind) {
        if (uiCallbacks.size >= 1024) throw Error("MODS_UI_CALLBACK_LIMIT");
        const handle = ++uiSequence;
        constructorApply(constructorMapSet,uiCallbacks,[handle, {generation:scope.uiGeneration,callbacks:input.callbacks,
          requestId:scope.requestId,plugin:scope.plugin,element:result.props.key,
          component:scope.component}]);
        result.press = {plugin:scope.plugin,handle,
          ...(kind === "onLinkPress" ? {kind:"onLinkPress"} : {})};
      }
      if (kind && result.type !== "Markdown" && !result.press) throw Error("MODS_UI_CALLBACK");
      if (result.type === "Markdown") {
        if (Object.hasOwn(tree, "children") || Object.hasOwn(tree, "client"))
          throw Error("MODS_UI_MARKDOWN_INVALID");
        uiMarkdownProps(result.props, Boolean(result.press));
        return frozen(result);
      }
      if (result.type === "Client" && rootMatch)
        result.client = {plugin:scope.plugin};
      if (result.type === "Client" && !result.client) throw Error("MODS_UI_ACTION_OWNER");
      if (constructorArray(tree.children)) {
        result.children=[];
        for(let i=0;i<tree.children.length;i++) result.children.push(clone(tree.children[i],
          path === "" ? "children/" + i : path + "/children/" + i, depth + 1));
      }
      return frozen(result);
    }
    return clone(input.output, "", 0);
  }
  define(globalThis, "__functionUiConstructorBootstrap", { configurable:true, value:freeze({
    enter(token) { const old = asyncScope; asyncScope = constructorScope(token); return old; },
    restore(old) { asyncScope = old; },
    enterResolver(token) {
      const scope=constructorApply(constructorMapGet,resolverScopes,[token]);
      if(!scope||scope.ended)throw Error("MODS_UI_RESOLVE_FRAME");
      const old=asyncScope;asyncScope=scope;return old;
    },
    capture:constructorCapture,
    reconnect:constructorReconnect,
    currentFrame() {
      return asyncScope?.event==="ui.render"&&!asyncScope.ended
        ? asyncScope.budgetToken : undefined;
    },
    nativeTable(component) {
      const existing=constructorApply(constructorMapGet,constructorTables,[component]);
      if(existing)return existing;
      const table=constructorCreate(null);
      for(const name of ["Box","Text","Button","Input","Select","Link","Code","Svg","Markdown","Client"])
        table[name]=raw=>{
          const scope=asyncScope;
          if(scope?.uiConstructor){
            const props={...raw};
            const children=uiChildren(props.children);
            delete props.children;
            for(const key of constructorCallbackNames)delete props[key];
            if(name==="Link"&&typeof props.href!=="string")throw Error("MODS_UI_LINK_HREF");
            if(name==="Button"&&props.label===undefined&&children.length===1&&
                typeof children[0]==="string")props.label=children[0];
            if(name==="Button"&&props.key===undefined)props.key=props.label;
            const tree={type:name,props};
            if(name==="Markdown"){
              if(children.length)throw Error("MODS_UI_MARKDOWN_INVALID");
              uiMarkdownProps(props,false,true);
              return frozen(tree);
            }
            if(name==="Box"||name==="Text"||name==="Link")tree.children=children;
            return frozen(tree);
          }
          if(!scope||scope.event!=="ui.render"||scope.component!==component)
            throw Error("MODS_UI_RENDER_ENDED");
          return uiElements({plugin:{name:scope.plugin}},
            {surface:"desktop",component,requestId:scope.requestId})[name](raw);
        };
      const ready=freeze(table);constructorApply(constructorMapSet,constructorTables,[component,ready]);return ready;
    }
  })});
`
