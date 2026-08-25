import type { BrowserLocatorMetadata } from "../../../../shared/browser-types"
import { formatPlaywrightSelector } from "../common/playwright-codegen/projectLocatorAdapter"
import { getPlaywrightRecorderSourceBundle } from "../common/playwright-codegen/projectRecorderAdapter"

// Playwright 录制器动作通过这个前缀回传到 Electron 宿主。
export const PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX = "[PlaywrightScriptRecorder]"
export const PLAYWRIGHT_SCRIPT_RECORDER_INJECTION_FLAG = "__cmbPlaywrightScriptRecorderInstalled"
export const PLAYWRIGHT_SCRIPT_RECORDER_FRAME_CHANNEL_KEY =
  "__cmbPlaywrightScriptRecorderFrameChannelId"
export const PLAYWRIGHT_SCRIPT_RECORDER_FRAME_SELECTOR_HELPER =
  "__cmbPlaywrightGenerateFrameSelectorAtIndex"
export const PLAYWRIGHT_SCRIPT_RECORDER_ISOLATED_WORLD_ID = 10_173
const WINDOWS_FAKEPATH_PATTERN = /^[a-z]:\\fakepath\\(.+)$/iu

interface PlaywrightRecorderAction {
  name?: unknown
  selector?: unknown
  text?: unknown
  options?: unknown
  key?: unknown
  files?: unknown
  clickCount?: unknown
}

interface PlaywrightRecorderEnvelope {
  type?: unknown
  action?: PlaywrightRecorderAction
  locator?: PlaywrightScriptRecorderEventLocator & {
    target?: unknown
    role?: unknown
    label?: unknown
    placeholder?: unknown
    testId?: unknown
    accessibleName?: unknown
    textContent?: unknown
    isTarget?: unknown
  }
  timestamp?: unknown
  frameUrl?: unknown
  frameContext?: {
    instanceId?: unknown
    channelId?: unknown
    isTop?: unknown
    depth?: unknown
    frameElementIndex?: unknown
    frameElementSrc?: unknown
  }
}

export interface PlaywrightScriptRecorderMessageDiagnostic {
  actionName?: string
  clickCount?: number
  frameUrl?: string
  selector?: string
  frameContext?: {
    instanceId?: string
    channelId?: string
    isTop?: boolean
    depth?: number
    frameElementIndex?: number
    frameElementSrc?: string
  }
}

export interface PlaywrightScriptRecorderEventLocator extends Pick<
  BrowserLocatorMetadata,
  | "target"
  | "role"
  | "label"
  | "placeholder"
  | "testId"
  | "accessibleName"
  | "textContent"
  | "selector"
  | "playwrightLocator"
  | "framePath"
  | "isTarget"
  | "matchCount"
  | "nth"
> {
  tagName?: string
  inputType?: string
  isVisible?: boolean
}

export type PlaywrightScriptRecorderEvent =
  | {
      type: "click"
      timestamp?: string
      locator?: PlaywrightScriptRecorderEventLocator
      doubleClick?: boolean
      toggle?: "check" | "uncheck"
    }
  | {
      type: "fill"
      timestamp?: string
      locator?: PlaywrightScriptRecorderEventLocator
      value?: string
    }
  | {
      type: "select"
      timestamp?: string
      locator?: PlaywrightScriptRecorderEventLocator
      values?: string[]
    }
  | {
      type: "press"
      timestamp?: string
      locator?: PlaywrightScriptRecorderEventLocator
      key?: string
    }
  | {
      type: "fileUpload"
      timestamp?: string
      locator?: PlaywrightScriptRecorderEventLocator
      paths?: string[]
    }

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = readString(item)
    return text ? [text] : []
  })
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function readActionName(value: unknown): string | undefined {
  return readString(value)
}

function extractFakePathFileName(value: string | undefined): string | undefined {
  if (!value) return undefined
  return WINDOWS_FAKEPATH_PATTERN.exec(value)?.[1]
}

function isFileInputLocator(locator: PlaywrightScriptRecorderEventLocator | undefined): boolean {
  const tagName = locator?.tagName?.trim().toLowerCase() ?? ""
  const inputType = locator?.inputType?.trim().toLowerCase() ?? ""
  const selector = locator?.selector?.trim().toLowerCase() ?? ""

  if (inputType === "file") return true
  if (tagName !== "input") return false
  return /\[type\s*=\s*["']?file["']?\]/u.test(selector)
}

function shouldTreatFakePathFillAsFileUpload(
  locator: PlaywrightScriptRecorderEventLocator | undefined,
  value: string | undefined
): boolean {
  if (!extractFakePathFileName(value)) return false
  if (isFileInputLocator(locator)) return true

  const targetText = [
    locator?.target,
    locator?.label,
    locator?.accessibleName,
    locator?.textContent,
    locator?.selector
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")

  return /choose file|upload|file|上传|文件|附件|头像/iu.test(targetText)
}

function fileUploadLocatorForFakePathFill(
  locator: PlaywrightScriptRecorderEventLocator | undefined
): PlaywrightScriptRecorderEventLocator | undefined {
  if (!locator) return { selector: 'input[type="file"]', tagName: "input", inputType: "file" }
  if (isFileInputLocator(locator)) return locator

  return {
    ...locator,
    role: undefined,
    accessibleName: undefined,
    textContent: undefined,
    selector: 'input[type="file"]',
    playwrightLocator: undefined,
    tagName: "input",
    inputType: "file",
    matchCount: undefined,
    nth: undefined
  }
}

function locatorForAction(
  action: PlaywrightRecorderAction,
  rawLocator: PlaywrightRecorderEnvelope["locator"],
  framePath: string[]
): PlaywrightScriptRecorderEventLocator | undefined {
  const selector = readString(rawLocator?.selector ?? action.selector)
  if (!selector && !rawLocator) return framePath.length > 0 ? { framePath } : undefined

  return {
    target: readString(rawLocator?.target),
    role: readString(rawLocator?.role) as BrowserLocatorMetadata["role"] | undefined,
    label: readString(rawLocator?.label),
    placeholder: readString(rawLocator?.placeholder),
    testId: readString(rawLocator?.testId),
    accessibleName: readString(rawLocator?.accessibleName),
    textContent: readString(rawLocator?.textContent),
    selector,
    tagName: readString(rawLocator?.tagName),
    inputType: readString(rawLocator?.inputType),
    isVisible: typeof rawLocator?.isVisible === "boolean" ? rawLocator.isVisible : undefined,
    isTarget: rawLocator?.isTarget === true,
    matchCount: readNonNegativeInteger(rawLocator?.matchCount),
    nth: readNonNegativeInteger(rawLocator?.nth),
    playwrightLocator: selector
      ? formatPlaywrightSelector(selector, framePath)
      : readString(rawLocator?.playwrightLocator),
    framePath: framePath.length > 0 ? framePath : undefined
  }
}

function parseEnvelope(message: string): PlaywrightRecorderEnvelope | null {
  if (!message.startsWith(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX)) return null

  try {
    return JSON.parse(
      message.slice(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX.length)
    ) as PlaywrightRecorderEnvelope
  } catch {
    return null
  }
}

export function inspectPlaywrightScriptRecorderMessage(
  message: string
): PlaywrightScriptRecorderMessageDiagnostic | null {
  const envelope = parseEnvelope(message)
  if (!envelope) return null

  const clickCount =
    typeof envelope.action?.clickCount === "number" && Number.isFinite(envelope.action.clickCount)
      ? envelope.action.clickCount
      : undefined
  const depth =
    typeof envelope.frameContext?.depth === "number" &&
    Number.isInteger(envelope.frameContext.depth)
      ? envelope.frameContext.depth
      : undefined
  const frameElementIndex =
    typeof envelope.frameContext?.frameElementIndex === "number" &&
    Number.isInteger(envelope.frameContext.frameElementIndex)
      ? envelope.frameContext.frameElementIndex
      : undefined

  return {
    actionName: readActionName(envelope.action?.name),
    clickCount,
    frameUrl: readString(envelope.frameUrl),
    selector: readString(envelope.locator?.selector ?? envelope.action?.selector),
    frameContext: envelope.frameContext
      ? {
          instanceId: readString(envelope.frameContext.instanceId),
          channelId: readString(envelope.frameContext.channelId),
          isTop:
            typeof envelope.frameContext.isTop === "boolean"
              ? envelope.frameContext.isTop
              : undefined,
          depth,
          frameElementIndex,
          frameElementSrc: readString(envelope.frameContext.frameElementSrc)
        }
      : undefined
  }
}

export function parsePlaywrightScriptRecorderEvent(
  message: string,
  framePath: string[]
): PlaywrightScriptRecorderEvent | null {
  const envelope = parseEnvelope(message)
  if (!envelope || envelope.type !== "action" || !envelope.action) return null

  const action = envelope.action
  const timestamp = readString(envelope.timestamp)
  const locator = locatorForAction(action, envelope.locator, framePath)
  const name = readActionName(action.name)

  switch (name) {
    case "click":
    case "check":
    case "uncheck": {
      // label 激活控件产生的合成 click 以 clickCount=0 上报（JsonRecordActionTool
      // 没有 detail 过滤），这里丢弃以避免 checkbox/radio/switch 被重复记录，
      // 等价于 codegen 默认录制模式的 detail===0 过滤。
      if (name === "click" && Number(action.clickCount) === 0) return null
      return {
        type: "click",
        timestamp,
        locator,
        doubleClick: name === "click" && Number(action.clickCount) > 1,
        toggle: name === "check" ? "check" : name === "uncheck" ? "uncheck" : undefined
      }
    }
    case "fill":
      if (shouldTreatFakePathFillAsFileUpload(locator, readString(action.text))) {
        return {
          type: "fileUpload",
          timestamp,
          locator: fileUploadLocatorForFakePathFill(locator),
          paths: [extractFakePathFileName(readString(action.text))!]
        }
      }
      return {
        type: "fill",
        timestamp,
        locator,
        value: readString(action.text) ?? ""
      }
    case "select":
      return {
        type: "select",
        timestamp,
        locator,
        values: readStringArray(action.options)
      }
    case "press":
      return {
        type: "press",
        timestamp,
        locator,
        key: readString(action.key)
      }
    case "setInputFiles": {
      const paths = readStringArray(action.files)
      if (paths.length === 0) return null
      return {
        type: "fileUpload",
        timestamp,
        locator,
        paths
      }
    }
    default:
      return null
  }
}

export function buildPlaywrightScriptRecorderInjectionScript(frameChannelId = ""): string {
  const { injectedScriptSource, pollingRecorderSource } = getPlaywrightRecorderSourceBundle()
  const injectedScriptConstructor = buildPlaywrightModuleConstructorExpression(
    injectedScriptSource,
    "module.exports.InjectedScript()"
  )
  const pollingRecorderConstructor = buildPlaywrightModuleConstructorExpression(
    pollingRecorderSource,
    "module.exports.default()"
  )

  return String.raw`(() => {
    const RECORDER_FRAME_CHANNEL_ID = ${JSON.stringify(frameChannelId)};
    const FRAME_CHANNEL_KEY = ${JSON.stringify(PLAYWRIGHT_SCRIPT_RECORDER_FRAME_CHANNEL_KEY)};
    if (window.${PLAYWRIGHT_SCRIPT_RECORDER_INJECTION_FLAG}) {
      return typeof window[FRAME_CHANNEL_KEY] === "string"
        ? window[FRAME_CHANNEL_KEY]
        : RECORDER_FRAME_CHANNEL_ID;
    }

    const EVENT_PREFIX = ${JSON.stringify(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX)};
    const FRAME_SELECTOR_HELPER = ${JSON.stringify(
      PLAYWRIGHT_SCRIPT_RECORDER_FRAME_SELECTOR_HELPER
    )};
    const InjectedScriptConstructor = ${injectedScriptConstructor};
    const PollingRecorder = ${pollingRecorderConstructor};
    const RECORDER_OPTIONS = {
      isUnderTest: false,
      sdkLanguage: "javascript",
      testIdAttributeName: "data-testid",
      stableRafCount: 1,
      browserName: "chromium",
      isUtilityWorld: false,
      customEngines: []
    };

    let recorderMode = "recording";
    const recorderFrameInstanceId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);

    function text(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    function safeText(value, limit = 120) {
      const next = text(value).replace(/\s+/g, " ");
      return next ? next.slice(0, limit) : "";
    }

    function cssEscape(value) {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
      return String(value).replace(/([#.;?+*~':"!^$[\]()=>|/@])/g, "\\$1");
    }

    function labelForElement(element) {
      const ariaLabel = text(element.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;

      const labelledBy = text(element.getAttribute("aria-labelledby"));
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => safeText(node.textContent, 80))
          .filter(Boolean)
          .join(" ");
        if (label) return label;
      }

      const id = text(element.id);
      if (id) {
        const labelNode = document.querySelector('label[for="' + cssEscape(id) + '"]');
        const labelText = safeText(labelNode?.textContent, 80);
        if (labelText) return labelText;
      }

      const wrappedLabel = element.closest("label");
      const wrappedLabelText = safeText(wrappedLabel?.textContent, 80);
      if (wrappedLabelText) return wrappedLabelText;

      return "";
    }

    function roleForElement(element) {
      const explicitRole = text(element.getAttribute("role")).toLowerCase();
      if (explicitRole) return explicitRole;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "option") return "option";
      if (tag === "input") {
        const type = text(element.getAttribute("type")).toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "file") return "";
        if (element.hasAttribute("list")) return "combobox";
        return "textbox";
      }
      return "";
    }

    function targetForElement(element, label, accessibleName) {
      return (
        text(element.getAttribute("data-testid")) ||
        label ||
        text(element.getAttribute("placeholder")) ||
        accessibleName ||
        safeText(element.innerText || element.textContent, 80) ||
        text(element.getAttribute("title")) ||
        text(element.getAttribute("name"))
      );
    }

    function resolveElement(selector) {
      if (!selector) return null;
      try {
        const parsedSelector = injectedScript.parseSelector(selector);
        const element = injectedScript.querySelector(parsedSelector, injectedScript.document, false);
        return element instanceof Element ? element : null;
      } catch {
        return null;
      }
    }

    function isElementVisible(element) {
      if (!(element instanceof Element)) return false;
      const doc = element.ownerDocument;
      if (!doc || !doc.defaultView) return false;
      if (doc.hidden) return false;
      const style = doc.defaultView.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      for (let current = element.parentElement; current; current = current.parentElement) {
        const parentStyle = doc.defaultView.getComputedStyle(current);
        if (parentStyle.display === "none" || parentStyle.visibility === "hidden") return false;
      }
      return true;
    }

    function locatorForElement(element, selector) {
      if (!(element instanceof Element)) return selector ? { selector } : undefined;
      const tagName = element.tagName.toLowerCase();
      const label = labelForElement(element);
      const accessibleName =
        label ||
        text(element.getAttribute("aria-label")) ||
        safeText(element.innerText || element.textContent, 80);
      return {
        target: targetForElement(element, label, accessibleName),
        role: roleForElement(element),
        label,
        placeholder: text(element.getAttribute("placeholder")),
        testId: text(element.getAttribute("data-testid")),
        accessibleName,
        textContent: safeText(element.innerText || element.textContent, 80),
        selector,
        tagName,
        inputType:
          tagName === "input"
            ? text(element.getAttribute("type")).toLowerCase() || "text"
            : undefined,
        isVisible: isElementVisible(element),
        isTarget: true
      };
    }

    function resolveFileUploadPaths(element, fallbackFiles) {
      if (element instanceof HTMLInputElement && element.type === "file") {
        const paths = Array.from(element.files ?? [])
          .map((file) => {
            const path = text(file?.path);
            return path || text(file?.webkitRelativePath) || text(file?.name);
          })
          .filter(Boolean);
        if (paths.length > 0) return paths;
        const inputValue = text(element.value);
        if (inputValue) return [inputValue];
      }
      return Array.isArray(fallbackFiles)
        ? fallbackFiles
            .map((value) => text(value))
            .filter(Boolean)
        : [];
    }

    function fakePathFileName(value) {
      const match = text(value).match(/^[a-z]:\\fakepath\\(.+)$/i);
      return match ? match[1] : "";
    }

    function firstFileInputInScope(scope) {
      if (!scope || typeof scope.querySelector !== "function") return null;
      const input = scope.querySelector('input[type="file"]');
      return input instanceof HTMLInputElement ? input : null;
    }

    function fileInputForElement(element) {
      if (element instanceof HTMLInputElement && element.type.toLowerCase() === "file") {
        return element;
      }
      if (!(element instanceof Element)) return null;

      const label = element.closest("label");
      if (
        label instanceof HTMLLabelElement &&
        label.control instanceof HTMLInputElement &&
        label.control.type.toLowerCase() === "file"
      ) {
        return label.control;
      }

      for (let current = element; current instanceof Element; current = current.parentElement) {
        const scopedInput = firstFileInputInScope(current);
        if (scopedInput) return scopedInput;

        const shadowInput = current.shadowRoot ? firstFileInputInScope(current.shadowRoot) : null;
        if (shadowInput) return shadowInput;
      }

      const pageInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return pageInputs.length === 1 && pageInputs[0] instanceof HTMLInputElement
        ? pageInputs[0]
        : null;
    }

    function generatedSelectorForElement(element) {
      try {
        const generated = injectedScript.generateSelector(element, {
          testIdAttributeName: RECORDER_OPTIONS.testIdAttributeName,
          multiple: false
        });
        return text(generated?.selector);
      } catch {
        return "";
      }
    }

    function generatedSimpleSelectorForElement(element) {
      try {
        if (typeof injectedScript.generateSelectorSimple === "function") {
          return text(injectedScript.generateSelectorSimple(element));
        }
      } catch {}
      return generatedSelectorForElement(element);
    }

    function selectorForFrameElementAtIndex(index) {
      const numericIndex = Number(index);
      if (!Number.isInteger(numericIndex) || numericIndex < 0) return "";
      const frameElement = document.querySelectorAll("iframe, frame")[numericIndex];
      if (!(frameElement instanceof Element)) return "";
      return generatedSimpleSelectorForElement(frameElement);
    }

    function cssAttributeValue(value) {
      return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    function selectorForFileInput(element) {
      const generatedSelector = generatedSelectorForElement(element);
      if (generatedSelector) return generatedSelector;

      const id = text(element.id);
      if (id) return "#" + cssEscape(id);

      const name = text(element.getAttribute("name"));
      if (name) return 'input[name="' + cssAttributeValue(name) + '"]';

      return 'input[type="file"]';
    }

    function fallbackFileUploadLocator(locator) {
      return {
        ...(locator ?? {}),
        role: "",
        accessibleName: "",
        textContent: "",
        selector: 'input[type="file"]',
        tagName: "input",
        inputType: "file",
        matchCount: undefined,
        nth: undefined
      };
    }

    function recorderFrameContext() {
      let depth = 0;
      let currentWindow = window;
      while (currentWindow !== currentWindow.top && depth < 32) {
        depth += 1;
        currentWindow = currentWindow.parent;
      }

      let frameElementIndex = -1;
      let frameElementSrc = "";
      try {
        const frameElement = window.frameElement;
        if (frameElement instanceof Element) {
          frameElementIndex = Array.from(
            frameElement.ownerDocument.querySelectorAll("iframe, frame")
          ).indexOf(frameElement);
          frameElementSrc = text(frameElement.getAttribute("src"));
        }
      } catch {}

      return {
        instanceId: recorderFrameInstanceId,
        channelId: RECORDER_FRAME_CHANNEL_ID,
        isTop: window === window.top,
        depth,
        frameElementIndex,
        frameElementSrc
      };
    }

    function emitAction(payload) {
      try {
        console.log(EVENT_PREFIX + JSON.stringify({
          type: "action",
          ...payload,
          timestamp: new Date().toISOString(),
          frameUrl: location.href,
          frameContext: recorderFrameContext()
        }));
      } catch {}
    }

    // 这些函数是 Playwright 原生 recorder 运行时所要求的宿主桥接。
    // Electron 没有 Playwright BrowserContext，因此这里用 console-message
    // 复用项目已有的宿主通信通道。
    window.__pw_recorderState = async () => ({
      mode: recorderMode,
      actionSelector: undefined,
      actionPoint: undefined,
      ariaTemplate: undefined,
      language: "javascript",
      testIdAttributeName: "data-testid",
      overlay: { offsetX: 0 }
    });
    window.__pw_recorderElementPicked = async () => {};
    window.__pw_recorderSetMode = async (mode) => {
      if (typeof mode === "string") recorderMode = mode;
    };
    window.__pw_recorderSetOverlayState = async () => {};
    window.__pw_resume = async () => {};

    const injectedScript = new InjectedScriptConstructor(globalThis, RECORDER_OPTIONS);

    window[FRAME_SELECTOR_HELPER] = (index) => selectorForFrameElementAtIndex(index);

    window.__pw_recorderRecordAction = async (action) => {
      const selector = typeof action?.selector === "string" ? action.selector : "";
      const element = resolveElement(selector);
      const locator = locatorForElement(element, selector || undefined);
      const selectedFileName =
        action?.name === "fill" ? fakePathFileName(action?.text) : "";
      if (selectedFileName) {
        const fileInput = fileInputForElement(element);
        const fileInputSelector = fileInput ? selectorForFileInput(fileInput) : "";
        const fileInputLocator = fileInput
          ? locatorForElement(fileInput, fileInputSelector || undefined)
          : fallbackFileUploadLocator(locator);
        emitAction({
          action: {
            ...action,
            name: "setInputFiles",
            selector: fileInputLocator?.selector || fileInputSelector || 'input[type="file"]',
            files: fileInput
              ? resolveFileUploadPaths(fileInput, [selectedFileName])
              : [selectedFileName]
          },
          locator: fileInputLocator
        });
        return;
      }
      const normalizedAction = {
        ...action,
        files:
          action?.name === "setInputFiles"
            ? resolveFileUploadPaths(element, action?.files)
            : action?.files
      };
      emitAction({
        action: normalizedAction,
        locator
      });
    };

    // 默认录制模式（RecordActionTool）的 click/check/uncheck 动作走
    // performAction 桥接，这里同样记录到宿主，并保留 check/uncheck 语义。
    window.__pw_recorderPerformAction = async (action) => {
      await window.__pw_recorderRecordAction(action);
    };

    // 使用 Playwright 的 api 录制模式（JsonRecordActionTool）：不吞页面事件，
    // 录制时页面交互保持正常。label 激活控件产生的合成 click（detail=0）
    // 会以 clickCount=0 的 click 动作上报，由宿主的 parse 层丢弃（与 codegen
    // 的 detail===0 过滤一致），避免 checkbox/radio/switch 被重复记录。
    const recorder = new PollingRecorder(injectedScript, { recorderMode: "api" });
    try {
      const style = document.createElement("style");
      style.textContent = "x-pw-overlay { display: none !important; }";
      (document.head || document.documentElement).appendChild(style);
    } catch {}

    window.__cmbPlaywrightScriptRecorder = recorder;
    window.__pw_refreshOverlay?.();
    // Only mark the frame after all recorder hooks are installed so a transient
    // initialization error can be retried on the next frame lifecycle event.
    window.${PLAYWRIGHT_SCRIPT_RECORDER_INJECTION_FLAG} = true;
    window[FRAME_CHANNEL_KEY] = RECORDER_FRAME_CHANNEL_ID;
    return RECORDER_FRAME_CHANNEL_ID;
  })()`
}

function buildPlaywrightModuleConstructorExpression(
  source: string,
  exportExpression: string
): string {
  return String.raw`(() => {
    const module = { exports: {} };
    ${source}
    return ${exportExpression};
  })()`
}
