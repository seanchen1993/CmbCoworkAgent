/** Fixed WHATWG input vectors; expected answers come from Node's standard URL implementation. */
export const URL_PROBE_SOURCE = String.raw`
// Capture at module initialization: the larger differential batch gets its own invocation slice.
const ProbeURL = URL;
function urlProbe() {
  const error = fn => {try {return fn()} catch(e) {return e.name}};
  const inputs = [
    ["https://例子.测试:443/a/../中?q=😀#片段"],
    ["../b?x=1", "https://example.com/a/c"],
    ["http://user:p%40ss@[2001:db8::1]:8080/a"],
    ["file:///C:/a/../b%20c"], ["mailto:user@example.com"],
    ["data:text/plain,Hello%20world"], ["http://127.1"],
    ["http://0x7f000001"], ["https://a/\ud800?q=\udfff"],
    ["\t https://EXAMPLE.com:443/a\n"], ["http://[bad]"], ["relative"]
  ];
  const urls = inputs.map(args => error(() => {
    const u = new ProbeURL(...args);
    return [u.href,u.origin,u.protocol,u.username,u.password,u.host,u.hostname,u.port,u.pathname,u.search,u.hash,u.toJSON()];
  }));
  const linked = new ProbeURL("https://example.com/?a=1&a=2&b=hello+world");
  const params = linked.searchParams;
  params.append("emoji", "😀"); params.set("a", "3"); params.sort();
  const mutated = [linked.href, params.toString()];
  linked.search = "?z=1&z=2&x=%FF";
  mutated.push(params.toString(), String(params === linked.searchParams));
  params.delete("z", "1"); mutated.push(linked.href);
  linked.hostname = "例子.测试"; linked.port = "443"; linked.hash = "片段";
  mutated.push(linked.href);
  const p = new URLSearchParams([["b","2"],["a","1"],["a","3"]]);
  const iterated = [];
  p.forEach((value,key,self) => iterated.push([key,value,self === p]));
  p.sort();
  return {
    urls, mutated, iterated,
    params: [Array.from(p),p.getAll("a"),p.get("missing"),p.has("a","3"),p.has("a","4"),p.size,
      new URLSearchParams({x:"a b",empty:""}).toString(),new URLSearchParams("?x=%FF&x=+&y=%E4%B8%AD").toString()],
    canParse: inputs.map(args => ProbeURL.canParse(...args)),
    parse: inputs.map(args => {const u=ProbeURL.parse(...args);return u?u.href:null}),
    brands: [error(()=>URL.prototype.toString.call({})),error(()=>URLSearchParams.prototype.append.call({},"a","b")),
      error(()=>new URL(Symbol())),error(()=>new URLSearchParams([["x"]])),error(()=>URL("https://a")),
      Object.prototype.toString.call(new URL("https://a")),Object.prototype.toString.call(p)],
    globals: [typeof globalThis.process,typeof globalThis.require,typeof globalThis.fetch,typeof globalThis.document]
  };
}
`

export function expectedUrlProbe(): unknown {
  const result = new Function(`${URL_PROBE_SOURCE};return urlProbe()`)() as { globals: string[] }
  result.globals = Array(4).fill("undefined")
  return result
}
