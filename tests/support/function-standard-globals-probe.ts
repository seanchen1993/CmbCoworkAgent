/** Reused unchanged in QuickJS, utilityProcess and the desktop IPC smoke path. */
export const STANDARD_GLOBALS_PROBE_SOURCE = String.raw`
async function standardGlobalsProbe() {
  const bytes=new TextEncoder().encode("abc");
  const hashes=[];
  for(const name of ["SHA-1","sha-256","SHA-384","SHA-512"]){
    const digest=await crypto.subtle.digest({name},bytes);
    hashes.push(Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join(""));
  }
  const controller=new AbortController(), reason={kind:"stop"};
  const combined=AbortSignal.any([controller.signal]);
  let count=0;combined.addEventListener("abort",()=>count++,{once:true});
  controller.abort(reason);controller.abort("ignored");
  const data={items:new Map([["a",new Set([1,2])]])};data.self=data;
  const copy=structuredClone(data);
  const integers=new Uint16Array(8), returned=crypto.getRandomValues(integers);
  const t=performance.now();
  return {
    hashes,
    signal:combined instanceof AbortSignal&&combined.aborted&&combined.reason===reason&&count===1,
    clone:copy!==data&&copy.self===copy&&copy.items.get("a").has(2),
    random:returned===integers&&integers.byteLength===16,
    uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()),
    monotonic:performance.now()>=t,
    bridgeHidden:typeof globalThis.__functionStandardHost==="undefined"
  };
}
`

export const EXPECTED_STANDARD_GLOBALS_PROBE = {
  hashes: [
    "a9993e364706816aba3e25717850c26c9cd0d89d",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
  ],
  signal: true,
  clone: true,
  random: true,
  uuid: true,
  monotonic: true,
  bridgeHidden: true
}
