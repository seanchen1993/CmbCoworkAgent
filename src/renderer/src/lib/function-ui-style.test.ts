import { expect, it } from "vitest"
import { functionUiStyle, functionUiHoverStyle } from "./function-ui-style"
import { functionUiColor } from "./function-ui-color"

it("maps native position, direction and style-only hover without widening CSS access", () => {
  expect(functionUiStyle({ type: "Box", props: { position: "absolute", left: -2, top: 1,
    display: "none", borderStyle: "round", borderDimColor: true, borderColor: "red" } }))
    .toMatchObject({ position: "absolute", left: "-2ch", top: "1lh", display: "none",
      borderColor: `color-mix(in srgb, ${functionUiColor("red")} 65%, transparent)` })
  expect(functionUiStyle({ type: "Text", props: { dir: "rtl", wrap: "middle" } }))
    .toMatchObject({ direction: "rtl", whiteSpace: "nowrap" })
  expect(functionUiHoverStyle({ type: "Box", props: { position: "relative", display: "none",
    hover: { display: "flex", left: 99, backgroundColor: "black" } } }))
    .toEqual({ display: "flex", backgroundColor: "black" })
  expect(functionUiHoverStyle({ type: "Button", props: { dimColor: true,
    hover: { dimColor: false, bold: true, underline: true } } }))
    .toEqual({ opacity: 1, fontWeight: "bold", textDecoration: "underline" })
})

it("maps bounded layout props into the same desktop renderer with existing units", () => {
  expect(
    functionUiStyle({
      type: "Box",
      props: {
        width: "100%",
        minWidth: 0,
        minHeight: 2,
        flexGrow: 1,
        flexShrink: 0,
        flexDirection: "row-reverse",
        flexWrap: "nowrap",
        rowGap: 1,
        columnGap: 2,
        paddingTop: 1,
        paddingBottom: 2,
        paddingLeft: 3,
        paddingRight: 4,
        marginBottom: 1,
        marginLeft: 2,
        marginRight: 3,
        alignSelf: "stretch",
        justifyContent: "space-evenly",
        backgroundColor: "black",
        overflow: "hidden"
      }
    })
  ).toMatchObject({
    width: "100%",
    minWidth: "0ch",
    minHeight: "2lh",
    flexGrow: 1,
    flexShrink: 0,
    flexDirection: "row-reverse",
    flexWrap: "nowrap",
    rowGap: 8,
    columnGap: 16,
    paddingTop: 8,
    paddingBottom: 16,
    paddingLeft: 24,
    paddingRight: 32,
    marginBottom: 8,
    marginLeft: 16,
    marginRight: 24,
    alignSelf: "stretch",
    justifyContent: "space-evenly",
    backgroundColor: "black",
    overflow: "hidden"
  })
  expect(functionUiStyle({ type: "Text", props: { wrap: "truncate" } })).toEqual(
    functionUiStyle({ type: "Text", props: { wrap: "truncate-end" } })
  )
  expect(
    functionUiStyle({ type: "Box", props: { gap: "sm", padding: "xl", marginTop: "xs" } })
  ).toMatchObject({ gap: 4, padding: 16, marginTop: 2 })
  expect(
    functionUiStyle({
      type: "Text",
      props: {
        size: "heading",
        weight: "regular",
        bold: true,
        mono: true,
        tabular: true
      }
    })
  ).toMatchObject({
    fontSize: 16,
    fontWeight: 400,
    fontFamily: "var(--font-mono)",
    fontVariantNumeric: "tabular-nums"
  })
  expect(
    functionUiStyle({ type: "Text", props: { bold: true, mono: false, tabular: false } })
  ).toMatchObject({
    fontWeight: "bold",
    fontFamily: "var(--font-sans)",
    fontVariantNumeric: "normal"
  })
})

it("renders the original example border, margin and inverse colors", () => {
  expect(
    functionUiStyle({
      type: "Box",
      props: { borderStyle: "round", borderColor: "magenta", marginTop: 1, paddingX: 1 }
    })
  ).toMatchObject({
    border: "1px solid var(--border)",
    borderColor: functionUiColor("magenta"),
    borderRadius: 6,
    marginTop: 8,
    paddingInline: 8
  })
  expect(
    functionUiStyle({
      type: "Text",
      props: { inverse: true, color: "cyan", backgroundColor: "navy" }
    })
  ).toMatchObject({ color: "navy", backgroundColor: "cyan" })
  expect(functionUiStyle({ type: "Text", props: { inverse: true } })).toMatchObject({
    color: functionUiColor("inverseText"),
    backgroundColor: functionUiColor("text")
  })
})

it("gives original truncation and wrapping modes real clipping/layout semantics", () => {
  expect(functionUiStyle({ type: "Text", props: { wrap: "truncate-start" } })).toMatchObject({
    direction: undefined,
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
    minWidth: 0,
    maxWidth: "100%"
  })
  expect(functionUiStyle({ type: "Text", props: { wrap: "truncate-end" } })).toMatchObject({
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden"
  })
  expect(functionUiStyle({ type: "Text", props: { wrap: "wrap" } })).toMatchObject({
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere"
  })
})

it("preserves explicit ANSI pairs and adapts inverse text without an explicit background", () => {
  for (const [color, backgroundColor] of [
    ["white", "black"],
    ["black", "white"]
  ]) {
    expect(functionUiStyle({ type: "Text", props: { color, backgroundColor } })).toMatchObject({
      color,
      backgroundColor
    })
    expect(
      functionUiStyle({ type: "Text", props: { color, backgroundColor, inverse: true } })
    ).toMatchObject({ color: backgroundColor, backgroundColor: color })
  }
  expect(
    functionUiStyle({ type: "Text", props: { color: "yellow", inverse: true } })
  ).toMatchObject({ color: "var(--background)", backgroundColor: "var(--mods-ansi-yellow)" })
  expect(
    functionUiStyle({ type: "Text", props: { color: "#abcdef", backgroundColor: "error" } })
  ).toMatchObject({ color: "#abcdef", backgroundColor: "var(--status-critical)" })
})

it("uses inherited text backgrounds for nested ANSI colors and inverse defaults", () => {
  expect(functionUiStyle({ type: "Text", props: { color: "white" } }, "black")).toMatchObject({
    color: "white",
    backgroundColor: undefined
  })
  expect(
    functionUiStyle({ type: "Text", props: { color: "white", inverse: true } }, "black")
  ).toMatchObject({ color: "black", backgroundColor: "white" })
})
