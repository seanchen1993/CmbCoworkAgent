import { afterEach, describe, expect, it } from "vitest"
import { ModSurfaceRuntime } from "./surface-runtime"

const instances: ModSurfaceRuntime[] = []
async function create(body: string) {
  const instance = await ModSurfaceRuntime.create(
    `var __cmbSurfaceMod={default(props,surface){${body}}}`
  )
  instances.push(instance)
  return instance
}
afterEach(() => instances.splice(0).forEach((instance) => instance.dispose()))

describe("isolated Client surface", () => {
  it("keeps state across props/resize and accepts repeated fresh actions", async () => {
    const client = await create(`const {Box,Text,Button}=surface.elements;
      if(surface.state===undefined)surface.setState(0);
      return h(Box,{},h(Text,{},props.label+":"+surface.state+":"+surface.columns),
        h(Button,{onPress:()=>{surface.setState(surface.state+1);surface.post({count:surface.state})}},"increment"));`)
    let snapshot = await client.update({
      kind: "render",
      props: { label: "A" },
      columns: 80,
      rows: 24
    })
    const button = () =>
      (snapshot.tree.children as Array<{ props: { onPress: string } }>)[1].props.onPress
    const previous = button()
    snapshot = await client.update({ kind: "press", handle: previous, value: null })
    expect(snapshot.message).toEqual({ count: 1 })
    snapshot = await client.update({ kind: "press", handle: button(), value: null })
    expect(snapshot.message).toEqual({ count: 2 })
    snapshot = await client.update({
      kind: "render",
      props: { label: "B" },
      columns: 100,
      rows: 30
    })
    expect(JSON.stringify(snapshot.tree)).toContain("B:2:100")
    await expect(client.update({ kind: "press", handle: previous, value: null })).rejects.toThrow(
      "MODS_UI_STALE_HANDLE"
    )
  })
  it("keeps Client instances isolated and grants no engine or ambient host capability", async () => {
    const body = `const {Text}=surface.elements;
      if(surface.state===undefined)surface.setState(props.initial);
      return h(Text,{},JSON.stringify({state:surface.state,globals:[typeof $,typeof process,typeof require,typeof document]}));`
    const a = await create(body)
    const b = await create(body)
    const first = await a.update({ kind: "render", props: { initial: 1 }, columns: 1, rows: 1 })
    const second = await b.update({ kind: "render", props: { initial: 9 }, columns: 1, rows: 1 })
    expect(JSON.stringify(first.tree)).toContain('state\\":1')
    expect(JSON.stringify(second.tree)).toContain('state\\":9')
    expect(JSON.stringify(first.tree)).toContain("undefined")
  })
  it("uses host-driven frame timers and releases the entire instance on unmount", async () => {
    const client = await create(`const {Text}=surface.elements;
      if(surface.state===undefined){surface.setState(0);surface.every(20,()=>surface.setState(surface.state+1));}
      return h(Text,{},surface.state);`)
    let snapshot = await client.update({ kind: "render", props: {}, columns: 10, rows: 5 })
    expect(snapshot.timers).toHaveLength(1)
    snapshot = await client.update({ kind: "tick", handle: snapshot.timers[0].id })
    expect(snapshot.tree.children).toEqual(["1"])
    client.dispose()
    await expect(client.update({ kind: "tick", handle: snapshot.timers[0].id })).rejects.toThrow(
      "MODS_UNLOADED"
    )
  })
})
