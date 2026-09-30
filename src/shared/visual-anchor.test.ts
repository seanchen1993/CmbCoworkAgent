import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  getElementAnchor,
  getElementLabel,
  getSelector
} from "../renderer/src/components/visual-edit/visual-anchor"

class FakeHTMLElement {
  tagName: string
  id = ""
  className = ""
  classList: string[] = []
  children: FakeHTMLElement[] = []
  parentElement: FakeHTMLElement | null = null
  ownerDocument: { body: FakeHTMLElement; defaultView: { scrollX: number; scrollY: number } }
  innerText = ""
  textContent = ""
  private attributes = new Map<string, string>()
  private rect = { left: 0, top: 0, width: 0, height: 0 }

  constructor(tagName: string, ownerDocument?: FakeHTMLElement["ownerDocument"]) {
    this.tagName = tagName.toUpperCase()
    this.ownerDocument =
      ownerDocument ??
      ({
        body: this,
        defaultView: { scrollX: 0, scrollY: 0 }
      } as FakeHTMLElement["ownerDocument"])
  }

  appendChild(child: FakeHTMLElement): void {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    this.children.push(child)
  }

  setClasses(classes: string[]): void {
    this.classList = classes
    this.className = classes.join(" ")
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.rect = rect
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect
  }
}

const globals = globalThis as unknown as Record<string, unknown>
const originalHTMLElement = globals.HTMLElement

beforeAll(() => {
  globals.HTMLElement = FakeHTMLElement
})

afterAll(() => {
  if (originalHTMLElement) {
    globals.HTMLElement = originalHTMLElement
  } else {
    Reflect.deleteProperty(globals, "HTMLElement")
  }
})

describe("visual-anchor", () => {
  it("builds stable selectors with classes and nth-of-type", () => {
    const body = new FakeHTMLElement("body")
    body.ownerDocument = { body, defaultView: { scrollX: 0, scrollY: 0 } }
    const container = new FakeHTMLElement("div", body.ownerDocument)
    container.setClasses(["panel", "__generated"])
    const firstButton = new FakeHTMLElement("button", body.ownerDocument)
    const secondButton = new FakeHTMLElement("button", body.ownerDocument)
    secondButton.setClasses(["primary"])

    body.appendChild(container)
    container.appendChild(firstButton)
    container.appendChild(secondButton)

    expect(getSelector(secondButton as unknown as Element)).toBe(
      "div.panel > button.primary:nth-of-type(2)"
    )
  })

  it("prefers readable aria labels when summarizing an element", () => {
    const element = new FakeHTMLElement("button")
    element.id = "save"
    element.setClasses(["primary"])
    element.setAttribute("role", "button")
    element.setAttribute("aria-label", "Save changes")
    element.textContent = "Ignored fallback"

    expect(getElementLabel(element as unknown as Element)).toBe(
      'button#save.primary[role=button] "Save changes"'
    )
  })

  it("creates anchors with page-space bbox and offset ratio", () => {
    const body = new FakeHTMLElement("body")
    body.ownerDocument = { body, defaultView: { scrollX: 10, scrollY: 20 } }
    const element = new FakeHTMLElement("section", body.ownerDocument)
    element.textContent = "Overview"
    element.setRect({ left: 100, top: 50, width: 200, height: 80 })
    body.appendChild(element)

    const anchor = getElementAnchor(
      element as unknown as Element,
      { x: 160, y: 90 },
      { targetPath: "index.html" }
    )

    expect(anchor).toMatchObject({
      selector: "section",
      tagName: "section",
      text: "Overview",
      bbox: { x: 110, y: 70, width: 200, height: 80 },
      offsetRatio: { x: 0.25, y: 0.25 },
      targetPath: "index.html"
    })
  })
})
