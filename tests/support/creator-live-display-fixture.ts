/** Only the label differs between these two sources; no business implementation is replaced. */
export const liveDisplaySource = `import type {Register} from "claude-code"
export const register:Register=(on)=>{
  on("ui.render",{component:"AbovePrompt"},async($,event)=>{
    const value=JSON.parse(await $.fs.read("a21-business-state.json")) as {startedAt?:number,status:string}
    const elapsed=value.startedAt?Math.max(0,Date.now()-value.startedAt):0
    const {Text}=$.ui.resolve(event)
    return Text({children:"A21 耗时卡 · "+elapsed+"ms · "+value.status})
  })
}`
export const liveDisplayFiles = (patched: boolean) => [
  { path: "plugin.json", text: JSON.stringify({ name: "a21-duration", version: "1.0.0", mods: "mods/manifest.json" }) },
  { path: "mods/manifest.json", text: JSON.stringify({ apiVersion: "cmb.mods/v2", id: "a21-duration", entry: "main.ts" }) },
  { path: "mods/main.ts", text: patched ? liveDisplaySource.replace("A21 耗时卡", "A21 累计耗时卡") : liveDisplaySource }
]
