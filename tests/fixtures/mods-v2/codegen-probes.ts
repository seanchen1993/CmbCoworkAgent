/** Runs as plugin source in real hooks, Client and utility-process guests. */
export const CODEGEN_PROBE_SOURCE = String.raw`
function codegenProbe() {
  return [
    () => eval("1 + 1"),
    () => (0,eval)("1 + 1"),
    () => new Function("return 2")(),
    () => ({}).constructor.constructor("return 2")(),
    () => (()=>{}).constructor("return 2")(),
    () => (function*(){}).constructor("yield 2")().next().value,
    () => Reflect.construct(Function,["return 2"])(),
    () => Function.bind(null,"return 2")()(),
    () => Object.getPrototypeOf(Object).constructor("return 2")()
  ].map(run => {try {return {executed:run()}} catch(error) {
    return {name:error.name,message:error.message}
  }});
}
`
export const CODEGEN_PROBE_COUNT = 9
