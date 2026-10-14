import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { URL_PROBE_SOURCE, expectedUrlProbe } from "../../../../tests/support/function-url-probe"

async function probe(expression: string, client = false, source = ""): Promise<unknown> {
  const code =
    source +
    (client
      ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
      : `var __cmbFunctionMod={register(on){on("command.run",()=>(${expression}))}}`)
  const guest = await FunctionGuestRuntime.create(code, { plugin: "url" })
  try {
    const result = await guest.invoke(
      "0",
      client ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
      async () => {
        throw Error("URL must not call the host")
      },
      {
        event: client ? "surface.update" : "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "url", root: "/url" }
      }
    )
    return client
      ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
      : result.value
  } finally {
    guest.dispose()
  }
}

it("initializes on the first URL use inside a command within the existing CPU slice", async () => {
  expect(await probe('new URL("https://例子.测试/a?q=中").href')).toBe(
    "https://xn--fsqu00a.xn--0zwm56d/a?q=%E4%B8%AD"
  )
})

it.each([false, true])("matches standard URL behavior in a real VM (Client=%s)", async (client) => {
  expect(await probe("urlProbe()", client, URL_PROBE_SOURCE)).toEqual(expectedUrlProbe())
})

it("keeps independent URL state across instances and VMs", async () => {
  const expression = `(()=>{const a=new URL("https://a/?x=1"),b=new URL("https://b/?x=2");
    a.searchParams.set("x","3");return [a.href,b.href]})()`
  expect(await probe(expression)).toEqual(["https://a/?x=3", "https://b/?x=2"])
  expect(await probe('new URL("https://a/?x=1").href')).toBe("https://a/?x=1")
})

it("rejects forged brands and implements live mutation during parameter iteration", async () => {
  const expression = `(()=>{const errors=[],bad=Object.create(URL.prototype);
    for(const fn of [()=>bad.href,()=>URLSearchParams.prototype.get.call({},"a"),
      ()=>new URLSearchParams(Symbol()),()=>URL.canParse(),()=>URL.parse()]){
      try{fn();errors.push("accepted")}catch(e){errors.push(e.name)}
    }
    const p=new URLSearchParams("a=1&b=2"),seen=[];
    p.forEach((v,k)=>{seen.push([k,v]);if(k==="a"){p.append("c","3");p.delete("b")}});
    return {errors,seen,remaining:Array.from(p)};
  })()`
  expect(await probe(expression)).toEqual(new Function(`return ${expression}`)())
})

it("preserves IDNA bidi, joiner and combining-mark validation with lazy Unicode regexes", async () => {
  const domains = [
    "مثال.إختبار",
    "שלום.example",
    "bücher.de",
    "faß.de",
    "ＦＯＯ.example",
    "\u0300a.example",
    "a\u200db.example",
    "क्\u200dष.example",
    "a\u200cb.example",
    "ا١۲.example",
    "אa.example",
    "א1.example",
    "א\u0300.example"
  ]
  const expression = `(()=>{return ${JSON.stringify(domains)}.map(domain=>{
    try{return new URL("https://"+domain).hostname}catch(error){return error.name}
  })})()`
  expect(
    await probe(expression, false, "const InitializeURL = URL; void InitializeURL;\n")
  ).toEqual(new Function(`return ${expression}`)())
})

it("records the pinned library's strict IDNA bidi boundary instead of claiming universal native equivalence", async () => {
  // Unmodified whatwg-url 14.2.0 rejects a leading digit in this RTL label. Node 22's ICU
  // currently accepts it. Keep the known difference explicit until Claude-runtime validation.
  expect(
    await probe(
      `(()=>{try{return new URL("https://1א.example").hostname}catch(e){return e.name}})()`
    )
  ).toBe("TypeError")
  expect(new URL("https://1א.example").hostname).toBe("xn--1-0hc.example")
})

it("keeps object URL and host globals unavailable", async () => {
  expect(
    await probe(`[typeof URL.createObjectURL,typeof URL.revokeObjectURL,
    typeof globalThis.process,typeof globalThis.require,typeof globalThis.fetch]`)
  ).toEqual(Array(5).fill("undefined"))
})

it("does not replace overwritten or deleted globals when their sibling is first used", async () => {
  expect(
    await probe(`(()=>{globalThis.URL=42;return [new URLSearchParams("a=1").get("a"),URL]})()`)
  ).toEqual(["1", 42])
  expect(
    await probe(
      `(()=>{delete globalThis.URL;return [new URLSearchParams("a=1").get("a"),typeof URL]})()`
    )
  ).toEqual(["1", "undefined"])
  expect(
    await probe(
      `(()=>{globalThis.URLSearchParams=42;return [new URL("https://a/?b=1").searchParams.get("b"),URLSearchParams]})()`
    )
  ).toEqual(["1", 42])
})

it("does not override non-configurable sibling globals during lazy initialization", async () => {
  expect(
    await probe(`(()=>{Object.defineProperty(globalThis,"URL",{value:42,configurable:false});
    return [new URLSearchParams("a=1").get("a"),URL]})()`)
  ).toEqual(["1", 42])
  expect(
    await probe(`(()=>{Object.defineProperty(globalThis,"URLSearchParams",{value:42,configurable:false});
    return [new URL("https://a/?b=1").searchParams.get("b"),URLSearchParams]})()`)
  ).toEqual(["1", 42])
  expect(
    await probe(`(()=>{Object.defineProperty(globalThis,"URL",{configurable:false});
    return new URL("https://a").href})()`)
  ).toBe("https://a/")
})

it("does not grant code generation through URL constructors", async () => {
  expect(
    await probe(
      `(()=>{try{return URL.constructor("return globalThis")()}catch(e){return e.message}})()`
    )
  ).toBe("MODS_CODE_GENERATION_DENIED")
})

it("hides the initializer and never evaluates arguments passed to a captured lazy getter", async () => {
  expect(
    await probe(`(()=>{
    const get=Object.getOwnPropertyDescriptor(globalThis,"URL").get;
    const C=get.call(null,"globalThis.injected=true");
    const denied=fn=>{try{fn();return false}catch{return true}};
    return [typeof globalThis.__functionInitializeUrl,typeof globalThis.injected,
      new C("https://example.com").href,denied(()=>C.canParse.constructor("return globalThis")()),
      denied(()=>C.constructor("return process")())];
  })()`)
  ).toEqual(["undefined", "undefined", "https://example.com/", true, true])
})

it("remains isolated when guest code poisons objects before lazy initialization", async () => {
  expect(
    await probe(`(()=>{
    Object.defineProperties=()=>{throw new Error("poisoned")};
    try{new URL("https://example.com")}catch{}
    return [typeof globalThis.process,typeof globalThis.require,typeof globalThis.__functionInitializeUrl,
      (()=>{try{Function("return 1")();return false}catch{return true}})()];
  })()`)
  ).toEqual(["undefined", "undefined", "undefined", true])
})

it("retains the guest execution budget for hostile parameter iterables", async () => {
  await expect(
    probe(
      `new URLSearchParams({[Symbol.iterator](){return {next(){return {done:false,value:["x","y"]}}}}})`
    )
  ).rejects.toThrow()
})
