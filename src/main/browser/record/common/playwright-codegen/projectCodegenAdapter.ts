import type * as actions from "./codegen/actions"
import { JavaScriptLanguageGenerator } from "./codegen/javascript"
import type { LanguageGeneratorOptions } from "./codegen/types"
import {
  buildFullSelector,
  resolvePlaywrightSelector,
  type LocatorRole,
  type LocatorSource
} from "./projectLocatorAdapter"
import type { BrowserRecordedAction } from "../../../../../shared/browser-types"

const PLAYWRIGHT_CODEGEN_OPTIONS: LanguageGeneratorOptions = {
  browserName: "chromium",
  launchOptions: {},
  contextOptions: {}
}

const ACTION_GENERATOR = new JavaScriptLanguageGenerator(true)

function toLocatorSource(action: BrowserRecordedAction): LocatorSource {
  const locator = action.locator
  return {
    target: locator?.target ?? ("target" in action ? action.target : undefined),
    role: locator?.role as LocatorRole | undefined,
    label: locator?.label,
    placeholder: locator?.placeholder,
    testId: locator?.testId,
    accessibleName: locator?.accessibleName,
    textContent: locator?.textContent,
    selector: locator?.selector,
    tagName: locator?.tagName,
    inputType: locator?.inputType,
    framePath: locator?.framePath,
    textExact: locator?.textExact,
    matchCount: locator?.matchCount,
    nth: locator?.nth,
    isVisible: locator?.isVisible
  }
}

function resolveActionSelector(action: BrowserRecordedAction): string | undefined {
  // 脚本录制：recorder 的 selector 就是 codegen 生成的内部选择器，直接复用，
  // 让脚本输出与 Playwright codegen CLI 完全一致；选择器缺失时
  // 回退到元数据管线。
  if (action.source === "script" && action.locator?.selector) {
    return buildFullSelector(action.locator.framePath, action.locator.selector)
  }
  switch (action.kind) {
    case "navigate":
      return undefined
    case "click":
    case "fill":
    case "selectOption":
    case "press":
    case "fileUpload":
      return resolvePlaywrightSelector(
        action.kind === "fileUpload"
          ? {
              ...toLocatorSource(action),
              tagName: action.locator?.tagName ?? "input",
              inputType: action.locator?.inputType ?? "file"
            }
          : toLocatorSource(action),
        action.kind === "fill"
          ? { defaultRole: "textbox" }
          : action.kind === "selectOption"
            ? { defaultRole: "combobox" }
            : {}
      )
  }
}

function toActionInContext(action: BrowserRecordedAction): actions.ActionInContext | null {
  switch (action.kind) {
    case "navigate":
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "navigate",
          url: action.url
        }
      }
    case "click": {
      const selector = resolveActionSelector(action)
      if (!selector) return null
      if (action.toggle === "check" || action.toggle === "uncheck") {
        return {
          pageGuid: "page",
          signals: [],
          action: {
            name: action.toggle,
            selector
          }
        }
      }
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "click",
          selector,
          button: "left",
          modifiers: 0,
          clickCount: action.doubleClick ? 2 : 1
        }
      }
    }
    case "fill": {
      const selector = resolveActionSelector(action)
      if (!selector) return null
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "fill",
          selector,
          text: action.value
        }
      }
    }
    case "selectOption": {
      const selector = resolveActionSelector(action)
      if (!selector) return null
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "select",
          selector,
          options: action.values
        }
      }
    }
    case "fileUpload": {
      const selector = resolveActionSelector(action)
      if (!selector) return null
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "setInputFiles",
          selector,
          files: action.paths
        }
      }
    }
    case "press": {
      const selector = action.target ? resolveActionSelector(action) : undefined
      if (!selector) return null
      return {
        pageGuid: "page",
        signals: [],
        action: {
          name: "press",
          selector,
          key: action.key,
          modifiers: 0
        }
      }
    }
  }
}

function trimGeneratedAction(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^ {2}/u, ""))
    .join("\n")
}

export function generatePlaywrightCodegenActionLines(
  actionsList: BrowserRecordedAction[]
): string[] {
  ACTION_GENERATOR.reset()
  return actionsList.flatMap((action) => {
    const actionInContext = toActionInContext(action)
    if (!actionInContext) return []
    const generated = ACTION_GENERATOR.generateAction(
      actionInContext,
      PLAYWRIGHT_CODEGEN_OPTIONS
    ).trim()
    if (!generated) return []
    return trimGeneratedAction(generated).split(/\r?\n/u)
  })
}
