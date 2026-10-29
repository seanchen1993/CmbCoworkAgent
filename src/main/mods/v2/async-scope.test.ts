import { AsyncLocalStorage } from "node:async_hooks"
import { runInNewContext } from "node:vm"
import { getQuickJS } from "quickjs-emscripten"
import { transformSync } from "esbuild"
import { describe, expect, it } from "vitest"
import { FUNCTION_ASYNC_SCOPE } from "./async-scope"

const cases = {
  concurrent: `const seen=[];let release;
    const gate=new Promise(r=>release=r);
    const a=__with("A",async()=>{await gate;seen.push(["a",__scope()]);return __scope()});
    const b=__with("B",async()=>{await Promise.resolve();release();await a;seen.push(["b",__scope()]);return __scope()});
    globalThis.answer=Promise.all([a,b]).then(values=>({seen,values}));`,
  captured: `const sdk=()=>__scope();
    const saved=async()=>{await Promise.resolve();return sdk()};
    globalThis.answer=Promise.all([__with("press-A",saved),__with("press-B",saved)]);`,
  stale: `const active=new Set(["A","B"]);let release;
    const gate=new Promise(r=>release=r);
    const a=__with("A",async()=>{await gate;return active.has(__scope())?__scope():"denied"});
    active.delete("A");
    const b=__with("B",async()=>{release();await a;return __scope()});
    globalThis.answer=Promise.all([a,b]);`,
  thenable: `const seen=[];
    globalThis.answer=__with("thenable",async()=>{
      await {then(resolve){seen.push(__scope());resolve(1)}};
      seen.push(__scope());return seen;
    });`,
  returnedThenable: `const seen=[];
    globalThis.answer=__with("returned",()=>Promise.resolve().then(()=>({then(resolve){seen.push(__scope());resolve(1)}})).then(()=>seen));`,
  resolvedElsewhere: `const seen=[];let settle;
    const p=__with("created-A",()=>new Promise(resolve=>settle=resolve));
    __with("resolved-B",()=>settle({then(resolve){seen.push(__scope());resolve(1)}}));
    globalThis.answer=p.then(()=>seen);`,
  resolvedOutside: `const seen=[];let settle;
    const p=__with("created-A",()=>new Promise(resolve=>settle=resolve));
    settle({then(resolve){seen.push(__scope());resolve(1)}});
    globalThis.answer=p.then(()=>seen);`,
  finally: `globalThis.answer=__with("finally",()=>Promise.resolve().finally(()=>{
    return Promise.resolve().then(()=>__scope())
  }).then(()=>__scope()));`,
  generator: `async function* items(){yield __scope();await Promise.resolve();yield __scope()}
    globalThis.answer=__with("generator",async()=>{const out=[];for await(const item of items())out.push(item);return out});`,
  settled: `const seen=[];
    globalThis.answer=__with("once",()=>new Promise((resolve,reject)=>{
      resolve(1);resolve({get then(){seen.push("bad");return r=>r(2)}});reject("bad");
    }).then(value=>({value,seen,scope:__scope()})));`,
  rejected: `globalThis.answer=__with("reject",()=>Promise.reject("bad").catch(async error=>{
    await Promise.resolve();return [error,__scope()];
  }));`,
  combinators: `globalThis.answer=__with("all",async()=>{
    const settled=await Promise.allSettled([Promise.resolve(1),Promise.reject(2)]);
    const first=await Promise.race([Promise.resolve(3)]);
    const any=await Promise.any([Promise.reject(4),Promise.resolve(5)]);
    return [settled,first,any,__scope()];
  });`,
  getter: `const seen=[];let settle;
    const p=__with("created",()=>new Promise(r=>settle=r));
    __with("resolved",()=>settle({get then(){seen.push(["get",__scope()]);return r=>{
      seen.push(["then",__scope()]);r(1);
    }}}));
    globalThis.answer=p.then(()=>seen);`,
  throwingThenable: `globalThis.answer=__with("throw",async()=>{
    try{await {get then(){throw Error("failure")}}}catch(error){return [error.message,__scope()]}
  });`,
  nested: `const seen=[];
    globalThis.answer=__with("outer",async()=>{
      try {__with("inner",()=>{seen.push(__scope());throw Error("nested")})} catch {}
      await Promise.resolve();seen.push(__scope());return seen;
    });`,
  detached: `let release;let task;
    __with("old",()=>{const p=new Promise(r=>release=r);task=p.then(()=>__scope())});
    globalThis.answer=__with("new",async()=>{release();return [await task,__scope()]});`
}

describe("guest continuation identity compared with Node AsyncLocalStorage", () => {
  for (const [name, source] of Object.entries(cases)) {
    it(name, async () => {
      const local = new AsyncLocalStorage<string>()
      const sandbox = {
        __with: (id: string, fn: () => unknown) => local.run(id, fn),
        __scope: () => local.getStore(),
        answer: undefined as unknown
      }
      runInNewContext(source, sandbox)
      const expected = JSON.parse(JSON.stringify(await sandbox.answer))
      const engine = await getQuickJS()
      const runtime = engine.newRuntime()
      runtime.setMemoryLimit(16 * 1024 * 1024)
      const context = runtime.newContext()
      try {
        const bootstrap = `(()=>{const define=Object.defineProperty.bind(Object);
          ${FUNCTION_ASYNC_SCOPE}
          globalThis.__with=inScope;globalThis.__scope=()=>asyncScope;})();`
        const evaluated = context.evalCode(
          bootstrap + transformSync(source, { target: "es2016" }).code
        )
        context.unwrapResult(evaluated).dispose()
        const answer = context.getProp(context.global, "answer")
        try {
          for (let step = 0; step < 1000 && runtime.hasPendingJob(); step++) {
            const jobs = runtime.executePendingJobs(100)
            if (jobs.error) {
              jobs.error.dispose()
              throw Error("guest continuation failed")
            }
          }
          const state = context.getPromiseState(answer)
          if (state.type !== "fulfilled") {
            if (state.type === "rejected") state.error.dispose()
            throw Error("unsettled continuation")
          }
          try {
            expect(JSON.parse(JSON.stringify(context.dump(state.value)))).toEqual(expected)
          } finally {
            state.value.dispose()
          }
        } finally {
          answer.dispose()
        }
      } finally {
        context.dispose()
        runtime.dispose()
      }
    })
  }
})
