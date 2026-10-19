import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { validateFunctionTree, type FunctionUiNode } from "../../../shared/mods/v2/ui"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

it("draws six controlled widgets from an actual guest and validates form intent before native file approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "platform-form-")),
    file = join(root, "result.txt")
  let permitted = true,
    calls = 0
  const threadId = randomUUID()
  claimLocalThreadRunLease({ threadId, owner: "mods", runId: "form", acquiredAt: "test" })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"open",description:"open"});return next(e)});
    on("command.run",{command:"open"},async($)=>{await $.ui.open({id:"widgets"});return {}});
    on("ui.render",{component:"Pane"},($,e)=>{const {Box,List,Table,Tree,Chart,Log,Form}=$.ui.resolve(e);return Box({children:[
      List({label:"Tasks",items:[{id:"one",label:"Actual task"}]}),Table({columns:[{key:"name",label:"Name"}],rows:[{name:"One"}]}),
      Tree({items:[{id:"root",label:"Root",children:[{id:"leaf",label:"Leaf"}]}]}),Chart({series:[{label:"done",value:1}]}),
      Log({entries:[{id:"event",text:"Host event",level:"info"}]}),Form({key:"settings",label:"Settings",fields:[{name:"title",label:"Title",type:"text",required:true}],
        values:{title:"Initial"},onSubmit:async json=>{const value=JSON.parse(json);await $.fs.write(${JSON.stringify(file)},value.title)}})]})})
  }}`)
  const session = new FunctionSession(
    [{ name: "widgets", root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: root,
      threadId,
      assertLive: () => {},
      publish: async (value) => value,
      assertCapability: (_, method) => {
        if (method === "fs.write" && !permitted)
          throw new ModFunctionError("MODS_CAPABILITY_DENIED")
      },
      callTool: async (_, input) => {
        calls++
        writeFileSync(String(input.file_path), String(input.content))
        return { result: { written: true }, text: "written" }
      }
    }
  )
  try {
    await session.run("open", "")
    const [pane] = await session.panes.snapshot()
    validateFunctionTree(pane.tree)
    expect(pane.tree).toHaveProperty("children")
    const nodes = (pane.tree as FunctionUiNode).children as FunctionUiNode[]
    expect(nodes.map((node) => node.type)).toEqual([
      "List",
      "Table",
      "Tree",
      "Chart",
      "Log",
      "Form"
    ])
    const form = nodes.at(-1)!,
      action = (value: string) => ({
        pane: pane.key,
        generation: pane.generation,
        intentId: randomUUID(),
        plugin: form.press!.plugin,
        handle: form.press!.handle,
        kind: "submit" as const,
        value
      })
    const submit = (value: string) =>
      withFunctionExecution(
        {
          workspace: root,
          threadId,
          turnId: "form",
          userInitiated: true,
          leased: true,
          immediate: false
        },
        () => session.panes.act(action(value))
      )
    await expect(session.panes.act(action('{"other":"forged"}'))).rejects.toThrow(
      "MODS_UI_WIDGET_INVALID"
    )
    expect(calls).toBe(0)
    await expect(session.panes.act(action('{"title":"No trusted user action"}'))).rejects.toThrow(
      "MODS_WRITE_REQUIRES_USER_ACTION"
    )
    await submit('{"title":"Saved through guest"}')
    expect(readFileSync(file, "utf8")).toBe("Saved through guest")
    permitted = false
    await expect(submit('{"title":"Denied"}')).rejects.toThrow()
    expect(readFileSync(file, "utf8")).toBe("Saved through guest")
    expect(calls).toBe(1)
  } finally {
    await session.close()
    releaseLocalThreadRunLease(threadId, "mods", "form")
    rmSync(root, { recursive: true, force: true })
  }
})

it("rejects unbounded widgets and arbitrary native/DOM properties", () => {
  expect(() =>
    validateFunctionTree({
      type: "Table",
      props: {
        columns: [{ key: "x", label: "x" }],
        rows: Array.from({ length: 201 }, () => ({ x: "x" }))
      }
    })
  ).toThrow()
  expect(() =>
    validateFunctionTree({ type: "List", props: { items: [], onClick: "native.ipc" } })
  ).toThrow()
  expect(() =>
    validateFunctionTree({ type: "Chart", props: { series: [{ label: "x", value: Infinity }] } })
  ).toThrow()
})
