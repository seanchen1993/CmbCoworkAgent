import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"

/** Runs in the function VM. Only data trees and opaque callback handles leave this closure. */
export const FUNCTION_UI_BOOTSTRAP = String.raw`
  const uiCallbacks = new Map();
  let uiSequence = 0;
  function uiChildren(input, depth = 0) {
    const result = [];
    let count = 0;
    function visit(value, level) {
      if (level > 24) throw Error("MODS_UI_DEPTH");
      if (++count > 1000) throw Error("MODS_UI_NODES");
      if (Array.isArray(value)) {
        for (const child of value) visit(child, level + 1);
      } else if (value !== null && value !== undefined && typeof value !== "boolean") {
        // Preserve structural fragments, especially empty Ask tails. Only arrays flatten.
        result.push(typeof value === "number" ? String(value) : value);
      }
    }
    visit(input, depth);
    return result;
  }
  const uiJsx = (tag, props, ...children) => {
    if (typeof tag !== "function") throw Error("MODS_UI_TAG");
    return tag({ ...props, ...(children.length ? { children } : {}) });
  };
  const uiFragment = props => frozen({
    type: "fragment", children: uiChildren(props?.children)
  });
  const uiMarkdownDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
  const uiMarkdownKeys = Reflect.ownKeys.bind(Reflect);
  function uiMarkdownText(value, maximum) {
    return typeof value === "string" && value.length <= maximum &&
      !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);
  }
  // Foreign native lower functions create actionless data. Only reconnect may restore Q's action.
  function uiMarkdownProps(props, hasPress, actionless = false) {
    if (!props || typeof props !== "object" || Array.isArray(props))
      throw Error("MODS_UI_MARKDOWN_INVALID");
    const fields = uiMarkdownDescriptors(props);
    if (uiMarkdownKeys(fields).some(key => typeof key !== "string" ||
        !["text", "key", "dimColor", "pressableLinks"].includes(key) ||
        !("value" in fields[key]) || !fields[key].enumerable))
      throw Error("MODS_UI_MARKDOWN_INVALID");
    if (!fields.text || !uiMarkdownText(fields.text.value, 10000) ||
        (fields.key && (!uiMarkdownText(fields.key.value, 256) || !fields.key.value)) ||
        (fields.dimColor && typeof fields.dimColor.value !== "boolean") ||
        (hasPress && !fields.key)) throw Error("MODS_UI_MARKDOWN_INVALID");
    if (!fields.pressableLinks) return;
    const links = fields.pressableLinks.value;
    if ((!hasPress && !actionless) || !Array.isArray(links) || links.length > 256 ||
        uiMarkdownKeys(links).length !== links.length + 1)
      throw Error("MODS_UI_MARKDOWN_INVALID");
    const entries = uiMarkdownDescriptors(links);
    for (let index = 0; index < links.length; index++) {
      const entry = entries[index];
      if (!entry || !("value" in entry) || !entry.enumerable ||
          !uiMarkdownText(entry.value, 2048) || !entry.value)
        throw Error("MODS_UI_MARKDOWN_INVALID");
    }
  }
  // Public classic-JSX globals share the same bounded constructors as compiled TSX.
  // Getter-only bindings also prevent QuickJS from redefining a global data value.
  define(globalThis, "h", { get: () => uiJsx });
  define(globalThis, "Fragment", { get: () => uiFragment });
  define(globalThis, "__functionJsx", { get: () => uiJsx });
  define(globalThis, "__functionFragment", { get: () => uiFragment });
  function uiElements(meta, input) {
    if (!input || input.surface !== "desktop" ||
        !${JSON.stringify(["Pane", ...FUNCTION_UI_SITES])}.includes(input.component) ||
        !asyncScope?.uiGeneration || asyncScope.event !== "ui.render" ||
        asyncScope.plugin !== meta.plugin.name || asyncScope.requestId !== input.requestId ||
        asyncScope.component !== input.component)
      throw Error("MODS_UI_SURFACE_UNAVAILABLE");
    const table = Object.create(null);
    for (const name of ["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Svg", "Markdown", "Client", "List", "Table", "Tree", "Chart", "Log", "Form"]) {
      table[name] = raw => {
        const scope = asyncScope;
        if (!scope || scope.event !== "ui.render" || !scope.uiGeneration ||
            scope.plugin !== meta.plugin.name || scope.requestId !== input.requestId ||
            scope.component !== input.component)
          throw Error("MODS_UI_RENDER_ENDED");
        const props = { ...raw };
        if (name === "Link" && typeof props.href !== "string") throw Error("MODS_UI_LINK_HREF");
        const children = uiChildren(props.children);
        delete props.children;
        const callbacks = {};
        for (const key of ["onPress", "onInput", "onSubmit", "onSelect", "onLinkPress"]) {
          if (props[key] !== undefined) {
            if (typeof props[key] !== "function") throw Error("MODS_UI_CALLBACK");
            callbacks[key] = props[key];
            delete props[key];
          }
          if (name === "Markdown") delete props[key];
        }
        if (name === "Markdown") for (const key of ["key", "dimColor", "pressableLinks"])
          if (props[key] === undefined) delete props[key];
        if (name === "Button" && props.label === undefined && children.length === 1 &&
            typeof children[0] === "string") props.label = children[0];
        if (name === "Button" && props.key === undefined) props.key = props.label;
        if (name === "Button" && props.hotkey !== undefined &&
            (typeof props.hotkey !== "string" || !/^[a-z0-9]$/.test(props.hotkey)))
          throw Error("MODS_UI_HOTKEY");
        const tree = { type: name, props };
        if (name === "Markdown") {
          if (children.length || ownKeys(callbacks).some(key => key !== "onLinkPress"))
            throw Error("MODS_UI_MARKDOWN_INVALID");
          const hasPress = typeof callbacks.onLinkPress === "function";
          uiMarkdownProps(props, hasPress);
          if (hasPress) {
            if (uiCallbacks.size >= 1024) throw Error("MODS_UI_CALLBACK_LIMIT");
            const handle = ++uiSequence;
            uiCallbacks.set(handle, {
              generation: scope.uiGeneration, callbacks, requestId: scope.requestId,
              plugin: scope.plugin, element: props.key, component: input.component
            });
            tree.press = { kind: "onLinkPress", plugin: scope.plugin, handle };
          }
          return frozen(tree);
        }
        if (name === "Client") tree.client = { plugin: scope.plugin };
        if (name === "Box" || name === "Text" || name === "Link") tree.children = children;
        if (["Button", "Input", "Select", "Form"].includes(name)) {
          const primary = name === "Button" ? "onPress" : name === "Select" ? "onSelect" : name === "Form" ? "onSubmit" : "onInput";
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
    if (kind === "onLinkPress") {
      if (!event.link || typeof event.link !== "object" || Array.isArray(event.link) ||
          ownKeys(event.link).length !== 1 || !uiMarkdownText(event.link.href, 2048) ||
          !event.link.href) throw Error("MODS_UI_MARKDOWN_INVALID");
    } else if (event.link !== undefined) throw Error("MODS_UI_MARKDOWN_INVALID");
    if (kind === "onInput" && fn === undefined) return () => {};
    if (typeof fn !== "function") throw Error("MODS_UI_CALLBACK");
    return () => kind === "onPress" ? fn(event) :
      kind === "onLinkPress" ? fn(event.link, event) : fn(event.value, event);
  }
  function uiHandles(tree, visit, depth = 0) {
    if (depth > 24) throw Error("MODS_UI_DEPTH");
    if (!tree || typeof tree !== "object") return;
    if (tree.type === "engine") return;
    if (tree.type === "fragment") {
      if (!Array.isArray(tree.children) || ownKeys(tree).length !== 2 ||
          ownKeys(tree).some(key => key !== "type" && key !== "children"))
        throw Error("MODS_UI_TREE_INVALID");
      for (const child of tree.children) uiHandles(child, visit, depth + 1);
      return;
    }
    if (tree.type === "Markdown") {
      if (Object.hasOwn(tree, "children") || Object.hasOwn(tree, "client"))
        throw Error("MODS_UI_MARKDOWN_INVALID");
      uiMarkdownProps(tree.props, Boolean(tree.press));
      if (tree.press) {
        if (tree.press.kind !== "onLinkPress") throw Error("MODS_UI_MARKDOWN_INVALID");
        visit(tree.press);
      }
      return;
    }
    if (!["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Svg", "Client", "List", "Table", "Tree", "Chart", "Log", "Form"]
        .includes(tree.type)) throw Error("MODS_UI_TREE_INVALID");
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
      if (record && press.kind === "onLinkPress" &&
          typeof record.callbacks.onLinkPress !== "function")
        throw Error("MODS_UI_ACTION_OWNER");
    });
  }
  define(globalThis, "__functionReleaseUi", { value: generation => {
    for (const [handle, record] of uiCallbacks)
      if (record.generation === generation) uiCallbacks.delete(handle);
  }});
`
