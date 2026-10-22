import { parseExpressionAt } from "acorn"
import { describe, expect, it } from "vitest"
import { analyzeUiCallback, isReusableUiCallback } from "./ui-render-purity"

const pure = (source: string): boolean =>
  isReusableUiCallback(parseExpressionAt(source, 0, { ecmaVersion: "latest" }))

describe("conservative callback expression purity", () => {
  it.each([
    `($,e,next)=>next(e)`,
    `($,event,lower)=>{return lower(event)}`,
    `()=>null`,
    `()=>({type:"Text",props:{text:"fixed"}})`,
    `($,e)=>({type:"Text",props:{text:e.props.text}})`,
    `($,e)=>({type:"fragment",children:[{type:"Text",props:{text:e.props.author.name}},"end"]})`,
    `($,e)=>({type:"Text",props:{text:e.props.text??""}})`,
    `($,e)=>({type:"Text",props:{text:typeof e.props.text==="string"?e.props.text:""}})`,
    '()=>{const n=2+3;const title=`Result ${n}`;return {type:"Text",props:{text:title}}}',
    `()=>({type:"Text",props:{text:1<2&&true||false}})`,
    `()=>({type:"Text",props:{text:!false,count:-2,kind:typeof 3}})`
  ])("accepts its bounded pure language: %s", (source) => {
    expect(pure(source)).toBe(true)
  })

  it.each([
    `($,e)=>({type:"Text",props:{text:count}})`,
    `($,e)=>{count++;return null}`,
    `($,e)=>{counter.value=1;return null}`,
    `($,e)=>({type:"Text",props:{text:Date.now()}})`,
    `($,e)=>({type:"Text",props:{text:Math.random()}})`,
    `($,e)=>({type:"Text",props:{text:$.state.get({})}})`,
    `($,e)=>({type:"Text",props:{text:$.session.cwd()}})`,
    `($,e)=>{const {Text}=$.ui.resolve(e);return Text({text:"x"})}`,
    `($,e)=>({type:"Client",props:{module:"./view"}})`,
    `($,e)=>({type:"Button",props:{label:"x"}})`,
    `($,e)=>({type:"Text",props:{onPress:()=>null}})`,
    `($,e)=>({type:"Text",props:{text:"x"},press:{plugin:"x",handle:1}})`,
    `($,e)=>({type:"Text",props:{get text(){return "x"}}})`,
    `($,e)=>({type:"Text",props:{...e.props}})`,
    `($,e)=>({type:"Text",props:{text:e.requestId}})`,
    `($,e)=>({type:"Text",props:{text:e.onScreen}})`,
    `($,e)=>({type:"Text",props:{text:e.props[e.props.key]}})`,
    `($,e)=>({type:"Text",props:{text:e.props.constructor.name}})`,
    `($,e)=>({type:"Text",props:{text:e.props.toString.caller}})`,
    `($,e)=>({type:"Text",props:{text:e.props.text+""}})`,
    '($,e)=>({type:"Text",props:{text:`${e.props.text}`}})',
    `async($,e,next)=>next(e)`,
    `($,e,next)=>next({...e})`,
    `($,e,next)=>{const lower=next;return lower(e)}`,
    `($,e,next)=>({type:"Box",props:{},children:[next(e)]})`,
    `($,e)=>{let n=1;return n}`,
    `($,e)=>{if(e.props.text)return "x";return "y"}`,
    `($,e)=>{const value={};value.text="x";return value}`,
    `($,{props})=>props.text`,
    `($,e)=>{return null;globalThis.changed=true}`
  ])("rejects an effect, dependency or unproved coercion: %s", (source) => {
    expect(pure(source)).toBe(false)
  })
})

describe("explicit named-state proof language", () => {
  const analyze = (body: string, render = true) =>
    analyzeUiCallback(
      parseExpressionAt(`($,e,next)=>__async(null,null,function*(){${body}})`, 0, {
        ecmaVersion: "latest"
      }),
      { namedState: true, compilerAsyncHelperVerified: true, render }
    )
  const ref = '{plugin:"theme",key:"mode",id:"panel"}'
  it("records only literal read references and allows frozen value/version data", () => {
    expect(
      analyze(`const snap=yield $.state.get(${ref});
      const value=snap.value;const n=snap.version+1;
      return {type:"Text",props:{text:value.label,count:n}};`)
    ).toEqual({
      environmentSafe: true,
      reusable: true,
      readsNamedState: [{ plugin: "theme", key: "mode", id: "panel" }]
    })
  })
  it("allows non-render awaited native writes as environment-safe, never reusable", () => {
    const code = `yield $.state.set(${ref},{mode:"dark"});return next(e);`
    expect(analyze(code, false)).toEqual({
      environmentSafe: true,
      reusable: false,
      readsNamedState: []
    })
    expect(analyze(code, true)).toEqual({
      environmentSafe: false,
      reusable: false,
      readsNamedState: []
    })
  })
  it("requires the independently verified compiler helper", () => {
    const callback = parseExpressionAt(
      `($,e)=>__async(null,null,function*(){
      const snap=yield $.state.get(${ref});return snap.value;
    })`,
      0,
      { ecmaVersion: "latest" }
    )
    expect(
      analyzeUiCallback(callback, {
        namedState: true,
        compilerAsyncHelperVerified: false,
        render: true
      }).environmentSafe
    ).toBe(false)
  })
  it("does not confuse a shadowed parameter or function name with the trusted helper", () => {
    for (const source of [
      `(__async,e,next)=>__async(null,null,function*(){return null})`,
      `(function __async($,e,next){return __async(this,null,function*(){return null})})`
    ]) {
      expect(
        analyzeUiCallback(parseExpressionAt(source, 0, { ecmaVersion: "latest" }), {
          namedState: true,
          compilerAsyncHelperVerified: true,
          render: true
        }).environmentSafe
      ).toBe(false)
    }
  })
  it.each([
    `const snap=yield $.state.get({plugin:"theme",key:e.props.key});return snap.value;`,
    `const ref=${ref};const snap=yield $.state.get(ref);return snap.value;`,
    `const snap=yield $.state.get({plugin:"theme",key:"mode",extra:"x"});return snap.value;`,
    `const snap=yield $.state.get({get plugin(){return "theme"},key:"mode"});return snap.value;`,
    `const snap=yield $.state.get({plugin:"theme",key:"mode",...e.props});return snap.value;`,
    `const snap=yield $.state.get({plugin:"theme",key:"mode"},{});return snap.value;`,
    `const snap=$.state.get(${ref});return snap.value;`,
    `const snap=yield* $.state.get(${ref});return snap.value;`,
    `const snap=yield $.state.get(${ref});return snap;`,
    `const snap=yield $.state.get(${ref});return snap.isSet;`,
    `const snap=yield $.state.get(${ref});return snap.value.constructor;`,
    `const snap=yield $.state.get(${ref});return {type:"Text",props:{text:Date.now()}};`,
    `const snap=yield $.state.get(${ref});snap.value="changed";return snap.value;`,
    `const snap=yield $.state.get(${ref});return e.requestId;`,
    `const snap=yield $.state.get(${ref});return snap.value+"";`,
    `const {value}=yield $.state.get(${ref});return value;`,
    `yield $.state.set(${ref},Math.random());return null;`,
    `yield $.state.set(${ref},{mode:"dark"},{ifVersion:1});return null;`,
    `const snap=yield $.store.get("mode");return snap.value;`,
    `const snap=yield $.state.get(${ref});return {type:"Button",props:{label:snap.value}};`
  ])("rejects dynamic, effectful or untracked state usage: %s", (body) => {
    expect(analyze(body).environmentSafe).toBe(false)
  })
})
