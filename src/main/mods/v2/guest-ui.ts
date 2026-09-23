/** Runs in the function VM. Only data trees and opaque callback handles leave this closure. */
export const FUNCTION_UI_BOOTSTRAP = String.raw`
  const uiCallbacks = new Map();
  let uiSequence = 0;
  function uiChildren(input, depth = 0) {
    if (depth > 24) throw Error("MODS_UI_DEPTH");
    const result = [];
    for (const value of Array.isArray(input) ? input : [input]) {
      if (Array.isArray(value)) result.push(...uiChildren(value, depth + 1));
      else if (value !== null && value !== undefined && typeof value !== "boolean")
        result.push(typeof value === "number" ? String(value) : value);
      if (result.length > 1000) throw Error("MODS_UI_NODES");
    }
    return result;
  }
  define(globalThis, "__functionJsx", { value: (tag, props, ...children) => {
    if (typeof tag !== "function") throw Error("MODS_UI_TAG");
    return tag({ ...props, ...(children.length ? { children } : {}) });
  }});
  define(globalThis, "__functionFragment", { value: props => ({
    type: "Box", props: {}, children: uiChildren(props?.children)
  }) });
  function uiElements(meta, input) {
    if (!input || input.surface !== "desktop" ||
        !["Pane", "AbovePrompt", "PromptHint", "InfoNotice", "Spinner", "TurnDuration", "SessionMode", "UserMessage", "AssistantMessage", "CommandOutput", "ToolUse", "ToolResult"].includes(input.component) ||
        !asyncScope?.uiGeneration || asyncScope.event !== "ui.render" ||
        asyncScope.plugin !== meta.plugin.name || asyncScope.requestId !== input.requestId ||
        asyncScope.component !== input.component)
      throw Error("MODS_UI_SURFACE_UNAVAILABLE");
    const table = Object.create(null);
    for (const name of ["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Svg", "Client"]) {
      table[name] = raw => {
        const scope = asyncScope;
        if (!scope || scope.event !== "ui.render" || !scope.uiGeneration ||
            scope.plugin !== meta.plugin.name || scope.requestId !== input.requestId ||
            scope.component !== input.component)
          throw Error("MODS_UI_RENDER_ENDED");
        const props = { ...raw };
        const children = uiChildren(props.children);
        delete props.children;
        const callbacks = {};
        for (const key of ["onPress", "onInput", "onSubmit", "onSelect"]) {
          if (props[key] !== undefined) {
            if (typeof props[key] !== "function") throw Error("MODS_UI_CALLBACK");
            callbacks[key] = props[key];
            delete props[key];
          }
        }
        if (name === "Button" && props.label === undefined && children.length === 1 &&
            typeof children[0] === "string") props.label = children[0];
        if (name === "Button" && props.key === undefined) props.key = props.label;
        const tree = { type: name, props };
        if (name === "Client") tree.client = { plugin: scope.plugin };
        if (name === "Box" || name === "Text" || name === "Link") tree.children = children;
        if (["Button", "Input", "Select"].includes(name)) {
          const primary = name === "Button" ? "onPress" : name === "Select" ? "onSelect" : "onInput";
          if (name === "Input" ? !callbacks.onSubmit : !callbacks[primary])
            throw Error("MODS_UI_CALLBACK");
          if (uiCallbacks.size >= 1024) throw Error("MODS_UI_CALLBACK_LIMIT");
          const handle = ++uiSequence;
          uiCallbacks.set(handle, {
            generation: scope.uiGeneration, callbacks, requestId: scope.requestId,
            plugin: scope.plugin, element: props.key, component: input.component
          });
          tree.press = { plugin: scope.plugin, handle };
        } else if (ownKeys(callbacks).length) throw Error("MODS_UI_CALLBACK");
        return frozen(tree);
      };
    }
    return freeze(table);
  }
  function uiCallback(meta, event) {
    const binding = meta.callback;
    const record = uiCallbacks.get(binding.handle);
    if (!record || record.generation !== binding.generation ||
        record.plugin !== meta.plugin.name || record.requestId !== event.requestId ||
        event.surface !== "desktop" || event.component !== record.component ||
        record.plugin !== event.plugin || record.element !== event.element)
      throw Error("MODS_UI_STALE_ACTION");
    const kind = binding.kind;
    const fn = record.callbacks[kind];
    if (kind === "onInput" && fn === undefined) return () => {};
    if (typeof fn !== "function") throw Error("MODS_UI_CALLBACK");
    return () => kind === "onPress" ? fn(event) : fn(event.value, event);
  }
  function uiHandles(tree, visit, depth = 0) {
    if (depth > 24) throw Error("MODS_UI_DEPTH");
    if (!tree || typeof tree !== "object") return;
    if (tree.press) visit(tree.press);
    if (tree.client) visit({ client: tree.client.plugin, module: tree.props?.module, key: tree.props?.key });
    if (Array.isArray(tree.children)) for (const child of tree.children) uiHandles(child, visit, depth + 1);
  }
  function uiProvenance(tree, meta, inherited) {
    uiHandles(tree, press => {
      if (press.client) {
        if (press.client !== meta.plugin.name && !inherited.has(pack(press)))
          throw Error("MODS_UI_ACTION_OWNER");
        return;
      }
      const record = press.plugin === meta.plugin.name && uiCallbacks.get(press.handle);
      if (record ? record.generation !== meta.uiGeneration : !inherited.has(pack(press)))
        throw Error("MODS_UI_ACTION_OWNER");
    });
  }
  define(globalThis, "__functionReleaseUi", { value: generation => {
    for (const [handle, record] of uiCallbacks)
      if (record.generation === generation) uiCallbacks.delete(handle);
  }});
`
