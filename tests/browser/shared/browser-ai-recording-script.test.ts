import { describe, expect, it } from "vitest"
import {
  applyAiRecordingVariableValues,
  buildAiRecordingExecutableScript,
  extractAiRecordingVariables,
  generateAiRecordingScript,
  parseAiRecordingScript
} from "../../../src/shared/browser-ai-recording-script"

describe("browser ai recording script", () => {
  it("preserves first occurrence hints when round-tripping parsed scripts", () => {
    const script = `import { test } from "@playwright/test";

test("AI recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.getByRole("button", { name: "Save" }).first().click();
});
`

    const parsed = parseAiRecordingScript(script, "ai")

    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "click",
        locator: expect.objectContaining({
          role: "button",
          accessibleName: "Save",
          matchCount: 2
        })
      })
    ])

    const regenerated = generateAiRecordingScript(parsed.actions, {
      source: "ai",
      variableActionIds: parsed.variableActionIds,
      variableActionNames: parsed.variableActionNames
    })

    expect(regenerated).toContain(
      "await page.getByRole('button', { name: 'Save', exact: true }).first().click();"
    )
  })

  it("strips the Playwright test wrapper for built-in browser execution", () => {
    const script = `import { test } from "@playwright/test";

const username = "alice";

test("manual recorded flow", async ({ page }) => {
  await page.goto("https://example.com");
  await page.getByRole("button", { name: "Save" }).click();
});
`

    expect(buildAiRecordingExecutableScript(script)).toBe(
      `const username = "alice";

  await page.goto("https://example.com");
  await page.getByRole("button", { name: "Save" }).click();`
    )
  })

  it("strips generated TypeScript array annotations for built-in browser execution", () => {
    const script = `import { test } from "@playwright/test";

const 变量_上传文件路径: string[] = []; // 变量-上传文件路径

test("manual recorded flow", async ({ page }) => {
  await page.locator("input[type=\\"file\\"]").setInputFiles(变量_上传文件路径);
});
`

    const executableScript = buildAiRecordingExecutableScript(script)

    expect(executableScript).toContain("const 变量_上传文件路径 = []; // 变量-上传文件路径")
    expect(executableScript).not.toContain(": string[]")
  })

  it("drops a redundant legacy choice click before the visible label click", () => {
    const script = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  await page.getByLabel("🎨 设计师 做设计的人").click();
  await page.locator("label:has(input[name=\\"role\\"][value=\\"designer\\"])").click();
});
`

    expect(buildAiRecordingExecutableScript(script)).toBe(
      'await page.locator("label:has(input[name=\\"role\\"][value=\\"designer\\"])").click();'
    )
  })

  it("prefers href selectors for duplicate links", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "workflow-link",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "Build Electron App",
          doubleClick: false,
          locator: {
            role: "link",
            accessibleName: "Build Electron App",
            target: "Build Electron App",
            selector: 'a[href="/seanchen1993/CmbCoworkAgent/actions/workflows/build-electron.yml"]',
            tagName: "a",
            matchCount: 2,
            nth: 1
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      `await page.locator('a[href="/seanchen1993/CmbCoworkAgent/actions/workflows/build-electron.yml"]:visible').click();`
    )
    expect(script).not.toContain(".nth(1)")
  })

  it("collapses file-input clicks into direct setInputFiles calls", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "upload-trigger",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "avatar",
          doubleClick: false,
          locator: {
            target: "avatar",
            role: "textbox",
            accessibleName: "avatar",
            selector: 'input[name="avatar"]',
            tagName: "input",
            inputType: "file"
          }
        },
        {
          id: "upload-file",
          timestamp: "2026-08-04T00:00:01.000Z",
          kind: "fileUpload",
          paths: ["think.webp"],
          locator: {
            target: "avatar",
            accessibleName: "avatar",
            selector: 'input[name="avatar"]',
            tagName: "input",
            inputType: "file"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).not.toContain('page.waitForEvent("filechooser")')
    expect(script).not.toContain('getByRole("textbox", { name: "avatar", exact: true }).click()')
    expect(script).not.toContain(`await page.locator('input[name="avatar"]').click();`)
    expect(script).toContain(
      `await page.locator('input[name="avatar"]').setInputFiles('think.webp');`
    )
  })

  it("migrates legacy fakepath fills on choose-file buttons into file uploads", () => {
    const script = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  await page.getByRole("button", { name: "Choose File" }).click();
  await page.getByRole("button", { name: "Choose File" }).fill("C:\\\\fakepath\\\\think.webp");
});
`

    const parsed = parseAiRecordingScript(script, "manual")

    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "click",
        target: "Choose File"
      }),
      expect.objectContaining({
        kind: "fileUpload",
        paths: ["think.webp"]
      })
    ])

    const regenerated = generateAiRecordingScript(parsed.actions, {
      source: "manual",
      variableActionIds: parsed.variableActionIds,
      variableActionNames: parsed.variableActionNames
    })

    expect(regenerated).toContain(
      "await page.getByRole('button', { name: 'Choose File', exact: true }).click();"
    )
    expect(regenerated).toContain(
      "await page.locator('input[type=file]').setInputFiles('think.webp');"
    )
    expect(regenerated).not.toContain("fakepath")
    expect(regenerated).not.toContain(".fill('")
  })

  it("preserves file-input locators when round-tripping setInputFiles scripts", () => {
    const script = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  await page.locator("input[name=\\"avatar\\"]").setInputFiles("think.webp");
});
`

    const parsed = parseAiRecordingScript(script, "manual")

    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "fileUpload",
        paths: ["think.webp"],
        locator: expect.objectContaining({
          selector: 'input[name="avatar"]',
          inputType: "file"
        })
      })
    ])

    const regenerated = generateAiRecordingScript(parsed.actions, {
      source: "manual",
      variableActionIds: parsed.variableActionIds,
      variableActionNames: parsed.variableActionNames
    })

    expect(regenerated).toContain(
      `await page.locator('input[name="avatar"]').setInputFiles('think.webp');`
    )
  })

  it("renders numeric fills with the spinbutton role", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "age-fill",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "fill",
          target: "年龄",
          value: "11",
          sensitive: false,
          locator: {
            label: "年龄",
            target: "年龄",
            tagName: "input",
            inputType: "number"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('spinbutton', { name: '年龄', exact: true }).fill('11');"
    )
  })

  it("renders range fills with the slider role", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "experience-fill",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "fill",
          target: "编程经验（年）",
          value: "6",
          sensitive: false,
          locator: {
            label: "编程经验（年）",
            target: "编程经验（年）",
            tagName: "input",
            inputType: "range"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('slider', { name: '编程经验（年）', exact: true }).fill('6');"
    )
  })

  it("supports marking navigation URLs as variables", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "navigate-home",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "navigate",
          url: "https://example.com/dashboard"
        }
      ],
      {
        source: "manual",
        variableActionIds: ["navigate-home"],
        variableActionNames: {
          "navigate-home": "目标地址"
        }
      }
    )

    expect(script).toContain('const 变量_目标地址 = ""; // 变量-目标地址')
    expect(script).toContain("await page.goto(变量_目标地址);")
  })

  it("round-trips variableized navigation steps and applies execution values", () => {
    const script = `import { test } from "@playwright/test";

const 变量_目标地址 = ""; // 变量-目标地址

test("manual recorded flow", async ({ page }) => {
  await page.goto(变量_目标地址);
});
`

    const parsed = parseAiRecordingScript(script, "manual")
    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "目标地址"
      })
    ])
    expect(parsed.variableActionNames).toEqual({
      "manual-seed-action-1": "目标地址"
    })

    const regenerated = generateAiRecordingScript(parsed.actions, {
      source: "manual",
      variableActionIds: parsed.variableActionIds,
      variableActionNames: parsed.variableActionNames
    })
    expect(regenerated).toContain("await page.goto(变量_目标地址);")

    expect(extractAiRecordingVariables(script)).toEqual([
      {
        identifier: "变量_目标地址",
        displayName: "目标地址",
        isArray: false
      }
    ])
    expect(
      applyAiRecordingVariableValues(script, { 变量_目标地址: "https://example.com/login" })
    ).toContain('const 变量_目标地址 = "https://example.com/login"; // 变量-目标地址')
  })

  it("recognizes variable declarations without comments or semicolons", () => {
    const script = `import { test } from "@playwright/test";

const 变量_目标地址 = ""

test("manual recorded flow", async ({ page }) => {
  await page.goto(变量_目标地址);
});
`

    const parsed = parseAiRecordingScript(script, "manual")
    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "目标地址"
      })
    ])
    expect(parsed.variableActionNames).toEqual({
      "manual-seed-action-1": "目标地址"
    })

    expect(extractAiRecordingVariables(script)).toEqual([
      {
        identifier: "变量_目标地址",
        displayName: "目标地址",
        isArray: false
      }
    ])
    expect(
      applyAiRecordingVariableValues(script, { 变量_目标地址: "https://example.com/login" })
    ).toContain('const 变量_目标地址 = "https://example.com/login"; // 变量-目标地址')
  })

  it("clicks radio-card choices with their semantic role", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "role-designer",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "🎨 设计师 做设计的人",
          doubleClick: false,
          locator: {
            role: "radio",
            label: "🎨 设计师 做设计的人",
            accessibleName: "🎨 设计师 做设计的人",
            target: "🎨 设计师 做设计的人",
            selector: 'input[name="role"][value="designer"]',
            tagName: "input",
            inputType: "radio"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('radio', { name: '🎨 设计师 做设计的人', exact: true }).click();"
    )
    expect(script).not.toContain(`page.locator('label:has(input[name="role"][value="designer"])')`)
  })

  it("uses the semantic radio locator even when the label is externally associated", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "role-designer",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "设计师",
          doubleClick: false,
          locator: {
            role: "radio",
            label: "设计师",
            accessibleName: "设计师",
            target: "设计师",
            selector: "#role-designer",
            tagName: "input",
            inputType: "radio"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('radio', { name: '设计师', exact: true }).click();"
    )
  })

  it("clicks switch-style checkboxes with their semantic role", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "email-notif-toggle",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "emailNotif",
          doubleClick: false,
          locator: {
            role: "checkbox",
            target: "emailNotif",
            selector: 'input[name="emailNotif"]',
            tagName: "input",
            inputType: "checkbox"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('checkbox', { name: 'emailNotif', exact: true }).click();"
    )
    expect(script).not.toContain('getByText("emailNotif", { exact: true }).click()')
  })

  it("clicks menuitem radio options with their semantic role", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "branch-option",
          timestamp: "2026-08-04T00:00:00.000Z",
          kind: "click",
          target: "fix/bug-doc-qyang",
          doubleClick: false,
          locator: {
            role: "menuitemradio",
            accessibleName: "fix/bug-doc-qyang",
            target: "fix/bug-doc-qyang",
            selector: 'button[name="branch"]',
            tagName: "button"
          }
        }
      ],
      { source: "manual" }
    )

    expect(script).toContain(
      "await page.getByRole('menuitemradio', { name: 'fix/bug-doc-qyang', exact: true }).click();"
    )
    expect(script).not.toContain('locator("button[name=\\"branch\\"]")')
  })
})
