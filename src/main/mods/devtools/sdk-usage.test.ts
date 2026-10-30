import { describe, expect, it } from "vitest"
import { analyzeFunctionSdk } from "./sdk-usage"

const scan = (body: string, modelProtocol: "legacy-v1" | "result-v1" = "legacy-v1") =>
  analyzeFunctionSdk({
    digest: "immutable-source",
    modelProtocol,
    authoringEntries: ["hooks/main.ts"],
    authoringSources: { "hooks/main.ts": `export function register(on) { ${body} }` }
  })

describe("static SDK compatibility", () => {
  const scanHelpers = (helper: string, call = "readInputs($, event)", extra = "") =>
    analyzeFunctionSdk({
      digest: "captured-helper-source", modelProtocol: "result-v1",
      authoringEntries: ["mods/main.ts"],
      authoringSources: {
        "mods/main.ts": `import { registerEvidence, readInputs } from "./helpers"
          export function register(on) { registerEvidence(on); ${extra}
            on("command.run", ($, event) => ${call}) }`,
        "mods/helpers.ts": `export function registerEvidence(on) {
          on("session.start", sdk => sdk.ui.log("ready"))
        }
        ${helper}`
      }
    })
  it("follows captured relative helpers and registrars without executing source or granting authority", async () => {
    const report = await scanHelpers(`export async function readInputs(sdk, data) {
      throw Error("DO NOT EXECUTE")
      return readFile(sdk, data.path)
    }
    const readFile = (sdk, path) => sdk.fs.read(path)`)
    expect(report.strictCompatible).toBe(true)
    expect(report.registrationEvents).toEqual(["command.run", "session.start"])
    expect(report.registrationEventsVerified).toBe(true)
    expect(report.runtimeVerified).toBe(false)
    expect(report.usages.map(row => row.method).sort()).toEqual(["fs.read", "ui.log"])
    expect(report.usages.every(row => row.file === "mods/helpers.ts")).toBe(true)
  })
  it("preserves unsupported-method and protocol diagnostics inside resolved helpers", async () => {
    const report = await scanHelpers(`export function readInputs(sdk) { return sdk.audio.speak("x") }`)
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      file: "mods/helpers.ts", code: "MODS_SDK_UNSUPPORTED"
    })]))
    const protocol = await scan(`function helper(sdk) {
      return sdk.model.complete({model:"x",prompt:"x",timeoutMs:10})
    } on("command.run", sdk => helper(sdk))`)
    expect(protocol.diagnostics.some(row => row.code === "MODS_SDK_PROTOCOL")).toBe(true)
  })
  it.each([
    'export function readInputs(sdk) { return sdk }',
    'export function readInputs(sdk) { return {sdk} }',
    'export function readInputs(sdk) { external(sdk) }',
    'export function readInputs(sdk) { sdk = {}; sdk.ui.log("x") }',
    'export function readInputs(sdk = fallback) { sdk.ui.log("x") }',
    'export function readInputs(...sdk) { sdk[0].ui.log("x") }',
    'export function readInputs(this: unknown, sdk) { sdk.audio.speak("x") }',
    'export function readInputs(sdk) { return () => sdk.ui.log("x") }',
    'export function readInputs(sdk) { return {call: () => sdk.ui.log("x")} }',
    'export function readInputs(sdk) { external(() => sdk.ui.log("x")) }',
    'export function readInputs(sdk) { return arguments[0].ui.log("x") }',
    'export let readInputs = sdk => sdk.ui.log("x")',
    'export function readInputs(sdk) {} readInputs = sdk => sdk.ui.log("x")',
    'export function readInputs(sdk) { return readInputs(sdk) }',
    'export function readInputs(sdk) { return other(sdk) } function other(sdk) { return readInputs(sdk) }',
    'export function readInputs(sdk) { sdk.ui.log("x") } export function readInputs(sdk) {}'
  ])("rejects unsafe helper parameter flow: %s", async helper => {
    const report = await scanHelpers(helper)
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics.some(row => row.code === "MODS_SDK_UNVERIFIED")).toBe(true)
  })
  it.each(["readInputs?.($)", "({readInputs}).readInputs($)", "readInputs(...[$])",
    "readInputs($.ui.log)", "readInputs($[event.key])", "external($)"])(
    "does not resolve dynamic or method transfers: %s", async call => {
      const report = await scanHelpers('export function readInputs(sdk) { sdk.ui.log("x") }', call)
      expect(report.strictCompatible).toBe(false)
    })
  it("rejects conflicting helper identities and unresolved third-party imports", async () => {
    const conflict = await scanHelpers('export function readInputs(sdk) {}', "readInputs($)",
      "readInputs(on);")
    expect(conflict.strictCompatible).toBe(false)
    const external = await analyzeFunctionSdk({ digest: "x", modelProtocol: "result-v1",
      authoringEntries: ["main.ts"], authoringSources: {
        "main.ts": 'import { helper } from "vendor"; export function register(on) { on("command.run", sdk => helper(sdk)) }',
        "vendor.ts": 'export function helper(sdk) { sdk.ui.log("x") }'
      } })
    expect(external.strictCompatible).toBe(false)
  })
  it("does not launder a captured SDK by also calling the closure as a direct helper", async () => {
    const report = await scan(`on("command.run", sdk => {
      function helper(unused) { return sdk.ui.log("x") }
      helper(sdk)
      return helper
    })`)
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics.some(row => row.message.includes("外层闭包"))).toBe(true)
  })
  it("checks local nonescaping direct closures without requiring redundant SDK parameters", async () => {
    const report = await scan(`on("command.run", sdk => {
      const redraw = () => sdk.ui.log("ready")
      function read() { return sdk.fs.read("input.json") }
      redraw(); return read()
    })`)
    expect(report.diagnostics).toEqual([])
    expect(report.usages.map(row => row.method).sort()).toEqual(["fs.read", "ui.log"])
  })
  it.each([
    'return helper', 'return {helper}', 'external(helper)', 'const alias = helper; alias()',
    'helper?.()', 'helper.call(null)', 'const box = [helper]',
    'return () => helper()', 'function nested() { helper() } return nested'
  ])("does not trust a local SDK closure with an escaping or dynamic reference: %s", async tail => {
    const report = await scan(`on("command.run", sdk => {
      const helper = () => sdk.ui.log("x")
      helper(); ${tail}
    })`)
    expect(report.strictCompatible).toBe(false)
  })
  it("checks methods and cycles in local closures", async () => {
    expect((await scan(`on("command.run", sdk => {
      const helper = () => sdk.audio.speak("x"); helper()
    })`)).strictCompatible).toBe(false)
    expect((await scan(`on("command.run", sdk => {
      function helper() { sdk.ui.log("x"); helper() }; helper()
    })`)).strictCompatible).toBe(false)
  })
  it("preserves native ui.render lexical callbacks with static calls and immutable aliases", async () => {
    const report = await scan(`on("ui.render", sdk => {
      const alias = sdk; const {ui} = alias
      const load = () => run(async () => { await alias.platform.list(); ui.log("ready") })
      return {onPress: () => load()}
    })`)
    expect(report.diagnostics).toEqual([])
    expect(report.usages.map(row => row.method).sort()).toEqual(["platform.list", "ui.log"])
    expect(report.runtimeVerified).toBe(false)
  })
  it.each([
    'return {onPress: () => sdk}', 'return {onPress: () => ({sdk})}',
    'return {onPress: () => sdk.ui}', 'return {onPress: () => sdk.ui.log}',
    'return {onPress: () => sdk[event.method]()}',
    'return {onPress: () => sdk.audio.speak("x")}',
    'return {onPress: () => external(sdk)}',
    'let alias = sdk; return {onPress: () => alias.ui.log("x")}',
    'function helper(value) { return () => value.ui.log("x") }; return helper(sdk)'
  ])("preserves UI escape, dynamic and helper-parameter restrictions: %s", async body => {
    expect((await scan(`on("ui.render", (sdk, event) => { ${body} })`)).strictCompatible).toBe(false)
  })
  it("does not give ordinary hooks the native UI lexical compatibility exception", async () => {
    expect((await scan(`on("command.run", sdk => external(() => sdk.ui.log("x")))`))
      .strictCompatible).toBe(false)
    expect((await scan(`function handle(sdk) { return () => sdk.ui.log("x") }
      on("ui.render", handle); on("command.run", handle)`)).strictCompatible).toBe(false)
    expect((await scan(`function handle(sdk) { return () => sdk.ui.log("x") }
      on("ui.render", handle); on("command.run", sdk => handle(sdk))`)).strictCompatible).toBe(false)
  })
  it("bounds the captured helper call graph", async () => {
    const calls = Array.from({ length: 257 }, (_, index) => `helper${index}($);`).join("\n")
    const helpers = Array.from({ length: 257 }, (_, index) =>
      `function helper${index}(sdk) { sdk.ui.log("x") }`).join("\n")
    const report = await scan(`${helpers} on("command.run", $ => { ${calls} })`)
    expect(report.strictCompatible).toBe(false)
    expect(report.truncated).toBe(true)
  })
  it.each(["检查文本", "text review", "", "a".repeat(65)])(
    "rejects an invalid literal command name before native startup: %s", async (name) => {
      const report = await scan(`on("session.start", async ($, event, next) => {
        await $.command.register({name:${JSON.stringify(name)},description:"检查文本"})
        return next(event)
      })`, "result-v1")
      expect(report.strictCompatible).toBe(false)
      expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        code: "MODS_SDK_UNSUPPORTED", message: expect.stringContaining("command.register.name")
      })]))
    }
  )
  it.each(["text-review", "text_review_1", "a".repeat(64)])(
    "preserves valid command names with Chinese descriptions: %s", async (name) => {
      const report = await scan(`on("session.start", async ($, event, next) => {
        await $.command.register({name:${JSON.stringify(name)},description:"检查文本"})
        return next(event)
      })`, "result-v1")
      expect(report.strictCompatible).toBe(true)
    }
  )
  const scanOwnTool = (registration: string, selector = "mcp__own_mod__format", name: string | undefined = "own.mod") =>
    analyzeFunctionSdk({
      name, digest: "immutable-own-tool", modelProtocol: "result-v1",
      authoringEntries: ["hooks/main.ts"],
      authoringSources: { "hooks/main.ts": `export function register(on) {
        on("session.start", async ($, event, next) => { ${registration}; return next(event) })
        on("tool.call", { tool: "${selector}" }, ($, event) => ({ result: event.text }))
      }` }
    })
  it("recognizes the exact canonical name of a bound SDK startup registration", async () => {
    const report = await scanOwnTool('await $.tool.register({name:"format",description:"Format"})')
    expect(report.strictCompatible).toBe(true)
    expect(report.diagnostics).toEqual([])
    expect(report.runtimeVerified).toBe(false)
    expect(report.digest).toBe("immutable-own-tool")
  })
  it.each([
    'await $.tool.register({name:"format",name:"other",description:"Format"})',
    'await $.tool.register({name:"other",name:"format",description:"Format"})',
    'await $.tool.register({name:"format",...options})',
    'await $.tool.register({["name"]:"format",description:"Format"})',
    'await $.tool.register({name:getName(),description:"Format"})',
    'const name="format"; await $.tool.register({name,description:"Format"})',
    'await unrelated.tool.register({name:"format",description:"Format"})',
    'const unused = ($) => $.tool.register({name:"format",description:"Format"})',
    'if (enabled) await $.tool.register({name:"format",description:"Format"})',
    'return next(event); await $.tool.register({name:"format",description:"Format"})',
    '$.tool.register({name:"format",description:"Format"})'
  ])("keeps ambiguous or unbound registration unverified: %s", async registration => {
    const report = await scanOwnTool(registration)
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MODS_SDK_UNVERIFIED", message: expect.stringContaining("mcp__own_mod__format") })
    ]))
    expect(report.runtimeVerified).toBe(false)
  })
  it.each(["mcp__vendor__format", "mcp__own_mod__other"])(
    "does not infer a provider for another owner or undeclared tool %s", async selector => {
      const report = await scanOwnTool('await $.tool.register({name:"format",description:"Format"})', selector)
      expect(report.strictCompatible).toBe(false)
      expect(report.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MODS_SDK_UNVERIFIED", message: expect.stringContaining(selector) })
      ]))
    }
  )
  it("requires the compiled package identity to recognize a local provider", async () => {
    const report = await scanOwnTool('await $.tool.register({name:"format",description:"Format"})', undefined, "")
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics.some(row => row.code === "MODS_SDK_UNVERIFIED")).toBe(true)
  })

  it.each(["Grep", "Glob", "MultiEdit"])(
    "reports unsupported original tool %s in literal hooks and SDK requests", async name => {
      for (const body of [
        `on("tool.call",{tool:"${name}"},($,e,next)=>next(e))`,
        `on("command.run",$=>$.tool.call({tool:"${name}"}))`,
        `on("command.run",$=>$.tool.check({tool:"${name}",input:{}}))`
      ]) {
        const report = await scan(body)
        expect(report.strictCompatible).toBe(false)
        expect(report.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "MODS_SDK_UNSUPPORTED", message: expect.stringContaining(name) })
        ]))
      }
    }
  )
  it.each([
    '"Read"', '"Bash"', '["Read","Write","Edit","Bash"]',
    '["read_file","execute"]', '/^(Read|Bash)$/', '/^(read_file|execute)$/', '/^Edit$/'
  ])("recognizes supported exact tool selector %s without misreporting native equivalence", async selector => {
    const report = await scan(`on("tool.call",{tool:${selector}},($,e,next)=>next(e))`)
    expect(report.diagnostics).toEqual([])
  })
  it("reports the unsupported member of a mixed matcher without rejecting supported names", async () => {
    const report = await scan('on("tool.call",{tool:["Read","Grep"]},($,e,next)=>next(e))')
    expect(report.diagnostics).toHaveLength(1)
    expect(report.diagnostics[0]).toMatchObject({ code: "MODS_SDK_UNSUPPORTED" })
    expect(report.diagnostics[0].message).toContain("Grep")
  })
  it.each(['getToolName()', '/Read/', '/^Read|Bash$/', '/^Read$/i'])(
    "keeps unresolved selector %s unverified instead of claiming all unsupported", async selector => {
      const report = await scan(`on("tool.call",{tool:${selector}},($,e,next)=>next(e))`)
      expect(report.strictCompatible).toBe(false)
      expect(report.diagnostics.some(row => row.code === "MODS_SDK_UNVERIFIED")).toBe(true)
      expect(report.diagnostics.some(row => row.code === "MODS_SDK_UNSUPPORTED")).toBe(false)
    }
  )
  it("distinguishes possible third-party providers and ignores unrelated event fields", async () => {
    const provider = await scan('on("tool.call",{tool:"mcp__vendor__search"},($,e,next)=>next(e))')
    expect(provider.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MODS_SDK_UNVERIFIED", message: expect.stringContaining("第三方") })
    ]))
    expect(provider.diagnostics.some(row => row.code === "MODS_SDK_UNSUPPORTED")).toBe(false)
    expect((await scan('on("command.run",{tool:"Grep"},($,e,next)=>next(e))')).diagnostics).toEqual([])
  })
  it("never reports an absent source snapshot as compatible", async () => {
    const result = await analyzeFunctionSdk({ digest: "missing", modelProtocol: "result-v1" })
    expect(result.strictCompatible).toBe(false)
    expect(result.runtimeVerified).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MODS_SDK_UNVERIFIED" })
    ]))
  })
  it.each(["cjs", "cts"])("inspects .%s modules instead of skipping their SDK calls", async (extension) => {
    const entry = `hooks/main.${extension}`
    const result = await analyzeFunctionSdk({
      digest: "immutable-source",
      modelProtocol: "legacy-v1",
      authoringEntries: [entry],
      authoringSources: {
        [entry]: 'export function register(on){on("command.run", $ => $.audio.speak("unsupported"))}'
      }
    })
    expect(result.strictCompatible).toBe(false)
    expect(result.usages).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "audio.speak", file: entry, support: "unsupported" })
    ]))
  })

  it("finds unsupported calls inside hooks without executing author code", async () => {
    const result = await scan(
      'on("command.run", ($) => { throw Error("NEVER EXECUTE"); $.audio.speak("x") })'
    )
    expect(result.strictCompatible).toBe(false)
    expect(result.runtimeVerified).toBe(false)
    expect(result.digest).toBe("immutable-source")
    expect(result.usages).toEqual([
      expect.objectContaining({
        method: "audio.speak",
        support: "unsupported",
        file: "hooks/main.ts",
        line: 1
      })
    ])
  })
  it("tracks const aliases, nested destructuring, literal keys and optional calls", async () => {
    const result = await scan(`on("command.run", ($) => {
      const sdk = $; const {ui: {log: write}} = sdk
      write("ok"); sdk["ui"]?.["ask"]?.({}); $.ui.log("fine")
    })`)
    expect(result.diagnostics).toEqual([])
    expect(result.usages.map((item) => item.method).sort()).toEqual(["ui.ask", "ui.log", "ui.log"])
  })
  it("ignores unrelated names, comments, strings and lexically shadowed SDK names", async () => {
    const result = await scan(`
      const $ = {audio:{speak(){}}}; $.audio.speak()
      on("command.run", ($) => {
        // $.audio.speak("comment")
        const text = "$.audio.speak()"
        function other($) { $.audio.speak(text) }
        $.ui.log(text)
      })
    `)
    expect(result.strictCompatible).toBe(true)
    expect(result.usages.map((item) => item.method)).toEqual(["ui.log"])
  })
  it.each([
    '$[event.noun].speak("x")',
    "helper($)",
    "helper($.ui.log)",
    "return $",
    "const box = {sdk:$}",
    "const box = {$}",
    'let alias = $; alias.ui.log("x")',
    '$ = event; $.ui.log("x")',
    'const { ...rest } = $; rest.audio.speak("x")',
    "const alias = $; alias = event",
    '$.ui.log.call(null, "x")'
  ])("never gives strict success to escaped or dynamic access: %s", async (body) => {
    const result = await scan(`on("command.run", ($, event) => { ${body} })`)
    expect(result.strictCompatible).toBe(false)
  })
  it.each(["const method = $.audio.speak", "const {audio: {speak}} = $"])(
    "rejects unavailable SDK access even if the alias is unused: %s",
    async (body) => {
      expect((await scan(`on("command.run", $ => { ${body} })`)).strictCompatible).toBe(false)
    }
  )
  it("recognizes local named handlers and the catch callback SDK", async () => {
    const result = await scan(`
      function handle(sdk) { sdk.ui.log("ok") }
      const listen = on
      const subscription = listen("command.run", handle)
      subscription.catch((sdk) => sdk.audio.speak("error"))
    `)
    expect(result.usages.map((item) => item.method).sort()).toEqual(["audio.speak", "ui.log"])
    expect(result.strictCompatible).toBe(false)
  })
  it("resolves an entry re-export without treating unrelated register functions as roots", async () => {
    const result = await analyzeFunctionSdk({
      digest: "x",
      modelProtocol: "legacy-v1",
      authoringEntries: ["entry.ts"],
      authoringSources: {
        "entry.ts": 'export { setup as register } from "./impl"',
        "impl.ts":
          'export const setup = (listen) => listen("command.run", ($) => $.audio.speak("x"))',
        "unrelated.ts": 'function register(on) { on("x", $ => $.audio.speak("x")) }'
      }
    })
    expect(result.usages).toHaveLength(1)
    expect(result.usages[0].file).toBe("impl.ts")
    expect(result.strictCompatible).toBe(false)
  })
  it("marks registrar transfers and missing entry information unverified", async () => {
    expect((await scan("install(on)")).strictCompatible).toBe(false)
    expect(
      (await analyzeFunctionSdk({ digest: "x", modelProtocol: "legacy-v1" })).strictCompatible
    ).toBe(false)
  })
  it("does not propagate SDK identity into the returned UI constructor table", async () => {
    const result = await scan(
      'on("ui.render", ($, event) => { const {Box} = $.ui.resolve(event); return Box({}) })'
    )
    expect(result.strictCompatible).toBe(true)
    expect(result.usages.map((item) => item.method)).toEqual(["ui.resolve"])
  })
  it("explains model protocol and tool registration differences", async () => {
    const code = 'on("command.run", $ => $.model.complete({model:"x",prompt:"x",timeoutMs:10}))'
    expect((await scan(code)).diagnostics.some((row) => row.code === "MODS_SDK_PROTOCOL")).toBe(
      true
    )
    expect((await scan(code, "result-v1")).strictCompatible).toBe(true)
    expect(
      (await scan('on("x", $ => $.tool.register({name:"x",isDeferred:false}))')).strictCompatible
    ).toBe(true)
    for (const placement of [",isDeferred:true", ",isDeferred:choice", ""]) {
      const result = await scan(`on("x", $ => $.tool.register({name:"x"${placement}}))`)
      expect(result.strictCompatible).toBe(true)
      expect(result.diagnostics.some((row) => row.code === "MODS_SDK_PROTOCOL")).toBe(false)
    }
    expect(
      (await scan('on("x", $ => $.model.complete({model:"x",prompt:"x"},{timeoutMs:2}))'))
        .strictCompatible
    ).toBe(false)
  })
  it.each(["input", "{...input}", "{[key]: 1}"])(
    "does not assert parameter compatibility for %s",
    async (input) => {
      expect(
        (await scan(`on("command.run", $ => $.model.complete(${input}))`)).strictCompatible
      ).toBe(false)
    }
  )
  it("marks engine replacement and unavailable SDK entry methods unverified", async () => {
    const result = await scan('on("engine.create", $ => $.ui.log("invalid context"))')
    expect(result.strictCompatible).toBe(false)
  })
  it("bounds diagnostics for large sources", async () => {
    const result = await scan(`on("command.run", $ => { ${'$.audio.speak("x");'.repeat(600)} })`)
    expect(result.truncated).toBe(true)
    expect(result.diagnostics.length).toBeLessThanOrEqual(512)
    expect(result.strictCompatible).toBe(false)
  })
  it.each([
    'on("command.run", function () { arguments[0].audio.speak("x") })',
    'on("command.run", function () { (() => arguments[0].audio.speak("x"))() })',
    'on("command.run", function ($, e, next, extra = arguments[0].audio.speak("x")) {})',
    'on("command.run", function ($, e, next, extra = (() => arguments[0].audio.speak("x"))()) {})',
    'let h = () => ({}); h = $ => $.audio.speak("x"); on("command.run", h)',
    'function h() {} h = $ => $.audio.speak("x"); on("command.run", h)',
    'function h() {} for (h of [$ => $.audio.speak("x")]) { on("command.run", h) }',
    'function h() {} for ({h} of [{h:$ => $.audio.speak("x")}]) { on("command.run", h) }',
    'const event = "engine.create"; on(event, $ => $.ui.log("x"))',
    'on("*", $ => $.ui.log("x"))',
    'on("engine.*", $ => $.ui.log("x"))',
    'on("!command.run", $ => $.ui.log("x"))',
    'on("command.run", () => ({})).catch(function () { arguments[0].audio.speak("x") })',
    'let h = () => ({}); h = $ => $.audio.speak("x"); on("command.run", () => ({})).catch(h)'
  ])("fails closed for mutable functions and hidden SDK contexts: %s", async (body) => {
    expect((await scan(body)).strictCompatible).toBe(false)
  })
  it.each([
    'export function register() { arguments[0]("command.run", $ => $.audio.speak("x")) }',
    'export let register = on => {}; register = on => on("command.run", $ => $.audio.speak("x"))',
    'export function register(on) {} register = on => on("command.run", $ => $.audio.speak("x"))'
  ])("does not trust a mutable or implicit entry: %s", async (source) => {
    const result = await analyzeFunctionSdk({
      digest: "x",
      modelProtocol: "legacy-v1",
      authoringSources: { "hooks/main.ts": source },
      authoringEntries: ["hooks/main.ts"]
    })
    expect(result.strictCompatible).toBe(false)
  })
  it("normalizes Windows entry paths and permits SDK-free wildcard observers", async () => {
    const result = await analyzeFunctionSdk({
      digest: "x",
      modelProtocol: "legacy-v1",
      authoringSources: {
        "hooks/main.ts": 'export function register(on) {on("*", (_, e, next) => next(e))}'
      },
      authoringEntries: ["hooks\\main.ts"]
    })
    expect(result.diagnostics).toEqual([])
  })
  it("bounds parsing input and recursive paths", async () => {
    const large = await scan(" ".repeat(3 * 1024 * 1024))
    expect(large.truncated).toBe(true)
    const deep = await scan('on("x", $ => $' + ".ui".repeat(100) + '.log("x"))')
    expect(deep.strictCompatible).toBe(false)
    expect(deep.truncated).toBe(true)
  })
})
