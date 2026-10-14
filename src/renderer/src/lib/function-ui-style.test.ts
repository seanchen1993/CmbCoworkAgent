import { expect, it } from "vitest"
import { functionUiStyle } from "./function-ui-style"
import { functionUiColor } from "./function-ui-color"

it("renders the original example border, margin and inverse colors", () => {
  expect(functionUiStyle({type:"Box",props:{borderStyle:"round",borderColor:"magenta",marginTop:1,paddingX:1}}))
    .toMatchObject({border:"1px solid var(--border)",borderColor:functionUiColor("magenta"),borderRadius:6,marginTop:8,paddingInline:8})
  expect(functionUiStyle({type:"Text",props:{inverse:true,color:"cyan",backgroundColor:"navy"}}))
    .toMatchObject({color:"navy",backgroundColor:"cyan"})
  expect(functionUiStyle({type:"Text",props:{inverse:true}}))
    .toMatchObject({color:functionUiColor("inverseText"),backgroundColor:functionUiColor("text")})
})

it("gives original truncation and wrapping modes real clipping/layout semantics", () => {
  expect(functionUiStyle({type:"Text",props:{wrap:"truncate-start"}}))
    .toMatchObject({direction:"rtl",whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden",minWidth:0,maxWidth:"100%"})
  expect(functionUiStyle({type:"Text",props:{wrap:"truncate-end"}}))
    .toMatchObject({whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden"})
  expect(functionUiStyle({type:"Text",props:{wrap:"wrap"}}))
    .toMatchObject({whiteSpace:"pre-wrap",overflowWrap:"anywhere"})
})

it("preserves explicit ANSI pairs and adapts inverse text without an explicit background", () => {
  for (const [color, backgroundColor] of [["white", "black"], ["black", "white"]]) {
    expect(functionUiStyle({ type: "Text", props: { color, backgroundColor } }))
      .toMatchObject({ color, backgroundColor })
    expect(functionUiStyle({ type: "Text", props: { color, backgroundColor, inverse: true } }))
      .toMatchObject({ color: backgroundColor, backgroundColor: color })
  }
  expect(functionUiStyle({ type: "Text", props: { color: "yellow", inverse: true } }))
    .toMatchObject({ color: "var(--background)", backgroundColor: "var(--mods-ansi-yellow)" })
  expect(functionUiStyle({ type: "Text", props: { color: "#abcdef", backgroundColor: "error" } }))
    .toMatchObject({ color: "#abcdef", backgroundColor: "var(--status-critical)" })
})

it("uses inherited text backgrounds for nested ANSI colors and inverse defaults", () => {
  expect(functionUiStyle({ type: "Text", props: { color: "white" } }, "black"))
    .toMatchObject({ color: "white", backgroundColor: undefined })
  expect(functionUiStyle({ type: "Text", props: { color: "white", inverse: true } }, "black"))
    .toMatchObject({ color: "black", backgroundColor: "white" })
})
