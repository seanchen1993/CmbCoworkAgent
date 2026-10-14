import { expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { validFunctionLink, validateFunctionTree } from "./ui"
import { normalizeFunctionLinks } from "./link-fallback"
import type { FunctionUiElement, FunctionUiNode } from "./ui"

it("keeps a frozen Markdown leaf and its own links separate from legacy Link fallback", () => {
  const markdown: FunctionUiElement = Object.freeze({
    type: "Markdown", props: Object.freeze({ text: "[Local](file:///C:/project/docs.txt)" })
  })
  expect(normalizeFunctionLinks(markdown)).toBe(markdown)
  const tree: FunctionUiElement = { type: "fragment", children: [markdown,
    { type: "Link", props: { href: "file:///C:/project/docs.txt", label: "Legacy" } }
  ] }
  const normalized = normalizeFunctionLinks(tree)
  expect(normalized.type).toBe("fragment")
  if (normalized.type !== "fragment") throw Error("actual fragment required")
  expect(normalized.children[0]).toBe(markdown)
  expect(normalized.children[1]).toEqual({ type: "Text", props: {}, children: ["Legacy"] })
})

it("preserves native leaves and refs when normalizing a frozen sibling Link", () => {
  const engine: FunctionUiElement = Object.freeze({ type: "engine", ref: 8 })
  expect(normalizeFunctionLinks(engine)).toBe(engine)
  const button: FunctionUiNode = Object.freeze({
    type: "Button", props: Object.freeze({ key: "act", label: "Act" }),
    press: Object.freeze({ plugin: "p", handle: 4 })
  })
  const children = [engine, button, {
    type: "Link", props: { href: "javascript:alert(1)", label: "Guide" }
  }] satisfies FunctionUiElement[]
  Object.freeze(children)
  const tree: FunctionUiNode = Object.freeze({ type: "Box", props: {}, children })
  const result = normalizeFunctionLinks(tree)
  expect(result).not.toBe(tree)
  expect(result.children![0]).toBe(engine)
  expect(result.children![1]).toBe(button)
  expect(result.children![2]).toEqual({ type: "Text", props: {}, children: ["Guide"] })
  expect((tree.children![2] as FunctionUiElement).type).toBe("Link")
  expect(Object.keys(engine)).toEqual(["type", "ref"])
})

it("keeps a bounded unsupported Link address from rejecting its whole sibling tree", () => {
  expect(() =>
    validateFunctionTree({
      type: "Box",
      props: {},
      children: [
        { type: "Text", props: {}, children: ["Sibling remains"] },
        { type: "Link", props: { href: "javascript:alert(1)", label: "Link text" }, children: [] }
      ]
    })
  ).not.toThrow()
})

it("accepts the original desktop HTTPS spelling without a trailing slash", () => {
  expect(validFunctionLink("https://example.com")).toBe(true)
})

it.each([
  "",
  "javascript:alert(1)",
  "file:///C:/private",
  "mailto:test@example.com",
  "http://example.com/",
  "https://example.com/a b",
  "https://例子.测试/",
  "https://user:pass@example.com/",
  "https://example.com/a@b",
  "https:/example.com",
  "https:///example.com",
  "https:////example.com",
  "http:localhost",
  "https://example.com\\path",
  "//example.com"
])("draws unsupported %s as plain text without changing the input", (href) => {
  const node: FunctionUiElement = Object.freeze({
    type: "Link",
    props: Object.freeze({ href, label: "Read guide" }),
    children: []
  })
  expect(normalizeFunctionLinks(node)).toEqual({
    type: "Text",
    props: {},
    children: ["Read guide"]
  })
  expect(node.type).toBe("Link")
  expect(node.props.href).toBe(href)
})

it.each([null, 123, false, { private: "ignored" }, ["ignored"]])(
  "does not stringify raw non-string href %j",
  (href) => {
    expect(normalizeFunctionLinks({ type: "Link", props: { href } })).toEqual({
      type: "Text",
      props: {},
      children: [""]
    })
  }
)

it("uses children before label, and string href before empty fallback", () => {
  const child: FunctionUiElement = { type: "Text", props: { bold: true }, children: ["Child"] }
  const original: FunctionUiElement = {
    type: "Link",
    props: { href: "file:///C:/guide", label: "Ignored" },
    children: [child]
  }
  const normalized = normalizeFunctionLinks(original)
  expect(normalized.children).toBe(original.children)
  expect(normalized.children![0]).toBe(child)
  expect(
    normalizeFunctionLinks({ type: "Link", props: { href: "file:///C:/guide" } }).children
  ).toEqual(["file:///C:/guide"])
  expect(normalizeFunctionLinks({ type: "Link", props: {} }).children).toEqual([""])
})

it("copies only changed ancestors and preserves safe links and sibling callback identities", () => {
  const button: FunctionUiElement = {
    type: "Button",
    props: { key: "act", label: "Act" },
    press: { plugin: "links", handle: 1 }
  }
  const safe: FunctionUiElement = { type: "Link", props: { href: "https://example.com" } }
  expect(normalizeFunctionLinks(safe)).toBe(safe)
  const parent: FunctionUiElement = {
    type: "Box",
    props: {},
    children: [button, safe, { type: "Link", props: { href: "", label: "Plain" } }]
  }
  const output = normalizeFunctionLinks(parent)
  expect(output).not.toBe(parent)
  expect(output.children![0]).toBe(button)
  expect(output.children![1]).toBe(safe)
  expect(button.press).toBe((output.children![0] as FunctionUiNode).press)
})

it.each(["x".repeat(2049), "bad\u001b[31m", "https://example.com/\n", "\t", "\u0085", "\u009f"])(
  "preserves size and control boundaries before fallback",
  (href) => expect(() => normalizeFunctionLinks({ type: "Link", props: { href } })).toThrow()
)

it("still refuses unrelated illegal trees and fabricated Link callbacks", () => {
  expect(() =>
    normalizeFunctionLinks({ type: "Link", props: { href: "", onClick: "code" } })
  ).toThrow()
  expect(() =>
    normalizeFunctionLinks({
      type: "Link",
      props: { href: "" },
      press: { plugin: "links", handle: 1 }
    })
  ).toThrow()
  expect(() =>
    normalizeFunctionLinks({ type: "Box", props: {}, children: Array(1001).fill("x") })
  ).toThrow()
})

it("measures bounded tree normalization without renderer or external opening claims", () => {
  const summary: Record<string, { samples: number; medianMs: number; p95Ms: number }> = {}
  for (const unsafe of [false, true]) {
    const tree: FunctionUiElement = {
      type: "Box",
      props: {},
      children: Array.from({ length: 400 }, (_, index) => ({
        type: "Link",
        props: {
          href: unsafe ? "javascript:alert(1)" : "https://example.com",
          label: "Link " + index
        },
        children: []
      }))
    }
    const samples: number[] = []
    for (let index = 0; index < 35; index++) {
      const started = performance.now()
      const result = normalizeFunctionLinks(tree)
      if (index >= 5) samples.push(performance.now() - started)
      expect((result.children![0] as FunctionUiNode).type).toBe(unsafe ? "Text" : "Link")
    }
    samples.sort((a, b) => a - b)
    summary[unsafe ? "fallback" : "safe"] = {
      samples: samples.length,
      medianMs: samples[15],
      p95Ms: samples[28]
    }
  }
  mkdirSync(resolve("output"), { recursive: true })
  writeFileSync(
    resolve("output/mods-link-performance.json"),
    JSON.stringify(
      {
        scope:
          "400 Link nodes, actual shared validation and clone-on-write normalization, 35 runs with five warmups excluded; no VM/IPC/DOM/OS/model claim",
        summary
      },
      null,
      2
    )
  )
})
