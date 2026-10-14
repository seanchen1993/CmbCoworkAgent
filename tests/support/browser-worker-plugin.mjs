import { build } from "esbuild"

/** Implement Vite's ?worker constructor in plain-esbuild browser fixtures using the real entry. */
export function browserWorkerPlugin() {
  return {
    name: "fixture-real-browser-workers",
    setup(builder) {
      builder.onResolve({ filter: /\?worker$/ }, async (args) => {
        const resolved = await builder.resolve(args.path.slice(0, -7), {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind
        })
        if (resolved.errors.length) return { errors: resolved.errors }
        return { path: resolved.path, namespace: "fixture-real-worker" }
      })
      builder.onLoad({ filter: /.*/, namespace: "fixture-real-worker" }, async (args) => {
        const worker = await build({
          entryPoints: [args.path],
          bundle: true,
          write: false,
          platform: "browser",
          format: "iife",
          alias: builder.initialOptions.alias,
          define: builder.initialOptions.define,
          target: builder.initialOptions.target,
          plugins: [browserWorkerPlugin()]
        })
        const source = worker.outputFiles[0].text
        return {
          loader: "js",
          contents: `const source = ${JSON.stringify(source)};
            const urls = new WeakMap();
            export default class FixtureWorker extends Worker {
              constructor(options) {
                const url = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
                try { super(url, options); }
                catch (error) { URL.revokeObjectURL(url); throw error; }
                urls.set(this, url);
              }
              terminate() {
                try { return super.terminate(); }
                finally { const url = urls.get(this); if (url) URL.revokeObjectURL(url); urls.delete(this); }
              }
            }`
        }
      })
    }
  }
}
