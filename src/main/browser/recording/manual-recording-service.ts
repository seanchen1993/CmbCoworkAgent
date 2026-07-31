import type { WebFrameMain } from "electron"
import type {
  AiRecordedBrowserAction,
  AiRecordingSession,
  BrowserLocatorMetadata,
  ManualRecordingStartOptions
} from "../../../shared/browser-types"
import { generateAiRecordingScript } from "../../../shared/browser-ai-recording-script"

const MANUAL_RECORDER_EVENT_PREFIX = "[ManualRecorder]"
const MANUAL_RECORDER_INJECTION_FLAG = "__cmbManualRecorderInstalled"

let activeSession: AiRecordingSession | null = null
let lastSession: AiRecordingSession | null = null
let nextSessionNumber = 0
let nextActionNumber = 0

interface ManualRecorderEventBase {
  type: string
  timestamp?: string
  frameUrl?: string
  frameHref?: string
}

interface ManualRecorderLocatorPayload {
  target?: string
  role?: string
  label?: string
  placeholder?: string
  testId?: string
  accessibleName?: string
  textContent?: string
  selector?: string
  tagName?: string
  inputType?: string
}

interface ManualRecorderClickEvent extends ManualRecorderEventBase {
  type: "click"
  locator?: ManualRecorderLocatorPayload
  doubleClick?: boolean
  button?: number
}

interface ManualRecorderFillEvent extends ManualRecorderEventBase {
  type: "fill"
  locator?: ManualRecorderLocatorPayload
  value?: string
}

interface ManualRecorderSelectEvent extends ManualRecorderEventBase {
  type: "select"
  locator?: ManualRecorderLocatorPayload
  values?: string[]
}

interface ManualRecorderPressEvent extends ManualRecorderEventBase {
  type: "press"
  locator?: ManualRecorderLocatorPayload
  key?: string
}

interface ManualRecorderNavigateEvent extends ManualRecorderEventBase {
  type: "navigate"
  url?: string
}

interface ManualRecorderFileUploadEvent extends ManualRecorderEventBase {
  type: "fileUpload"
  locator?: ManualRecorderLocatorPayload
  paths?: string[]
}

type ManualRecorderEvent =
  | ManualRecorderClickEvent
  | ManualRecorderFillEvent
  | ManualRecorderSelectEvent
  | ManualRecorderPressEvent
  | ManualRecorderNavigateEvent
  | ManualRecorderFileUploadEvent

const SUPPORTED_PRESS_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight"
])
const SENSITIVE_TARGET_PATTERN = /pass(word|code)?|secret|token|密码|口令/i

function now(): string {
  return new Date().toISOString()
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

function normalizeRole(value: unknown): BrowserLocatorMetadata["role"] {
  const role = readString(value)?.toLowerCase()
  if (!role) return undefined
  switch (role) {
    case "button":
    case "checkbox":
    case "combobox":
    case "link":
    case "menuitem":
    case "option":
    case "radio":
    case "switch":
    case "tab":
    case "textbox":
      return role
    default:
      return undefined
  }
}

function normalizeLocatorPayload(
  payload: ManualRecorderLocatorPayload | undefined,
  framePath: string[]
): BrowserLocatorMetadata | undefined {
  if (!payload) return framePath.length > 0 ? { framePath } : undefined

  const locator: BrowserLocatorMetadata = {
    target: readString(payload.target),
    role: normalizeRole(payload.role),
    label: readString(payload.label),
    placeholder: readString(payload.placeholder),
    testId: readString(payload.testId),
    accessibleName: readString(payload.accessibleName),
    textContent: readString(payload.textContent),
    selector: readString(payload.selector),
    tagName: readString(payload.tagName),
    inputType: readString(payload.inputType),
    framePath: framePath.length > 0 ? framePath : undefined
  }

  return Object.values(locator).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== ""
  })
    ? locator
    : undefined
}

function isSensitiveTarget(locator: BrowserLocatorMetadata | undefined): boolean {
  return Boolean(
    locator &&
      [
        locator.target,
        locator.label,
        locator.placeholder,
        locator.accessibleName,
        locator.testId,
        locator.inputType
      ].some((value) => value && SENSITIVE_TARGET_PATTERN.test(value))
  )
}

function actionTargetKey(action: AiRecordedBrowserAction): string {
  const target = "target" in action ? action.target : undefined
  const locator = action.locator
  return JSON.stringify({
    kind: action.kind,
    target: target ?? null,
    key: "key" in action ? action.key : null,
    locator: locator
      ? {
          target: locator.target,
          role: locator.role,
          label: locator.label,
          placeholder: locator.placeholder,
          testId: locator.testId,
          accessibleName: locator.accessibleName,
          textContent: locator.textContent,
          selector: locator.selector,
          framePath: locator.framePath
        }
      : null
  })
}

function appendAction(session: AiRecordingSession, action: AiRecordedBrowserAction): void {
  const previous = session.actions[session.actions.length - 1]
  if (!previous) {
    session.actions.push(action)
    return
  }

  const sameTarget = actionTargetKey(previous) === actionTargetKey(action)
  if (previous.kind === "navigate" && action.kind === "navigate") {
    if (previous.url === action.url) return
    session.actions[session.actions.length - 1] = action
    return
  }

  if (previous.kind === "fill" && action.kind === "fill" && sameTarget) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (
    previous.kind === "selectOption" &&
    action.kind === "selectOption" &&
    sameTarget &&
    previous.values.length === action.values.length &&
    previous.values.every((value, index) => value === action.values[index])
  ) {
    return
  }

  if (
    previous.kind === "press" &&
    action.kind === "press" &&
    sameTarget &&
    previous.key === action.key
  ) {
    return
  }

  if (
    previous.kind === "click" &&
    action.kind === "click" &&
    sameTarget &&
    previous.doubleClick === action.doubleClick
  ) {
    return
  }

  if (
    previous.kind === "click" &&
    action.kind === "click" &&
    sameTarget &&
    !previous.doubleClick &&
    action.doubleClick
  ) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (
    previous.kind === "fileUpload" &&
    action.kind === "fileUpload" &&
    previous.paths.length === action.paths.length &&
    previous.paths.every((value, index) => value === action.paths[index])
  ) {
    session.actions[session.actions.length - 1] = action
    return
  }

  session.actions.push(action)
}

function cloneAction(action: AiRecordedBrowserAction): AiRecordedBrowserAction {
  return {
    ...action,
    locator: action.locator
      ? {
          ...action.locator,
          framePath: action.locator.framePath ? [...action.locator.framePath] : undefined
        }
      : undefined
  }
}

function toView(session: AiRecordingSession | null): AiRecordingSession {
  if (!session) {
    return {
      source: "manual",
      status: "idle",
      actions: [],
      script: generateAiRecordingScript([], { source: "manual" })
    }
  }

  return {
    ...session,
    actions: session.actions.map(cloneAction),
    script: generateAiRecordingScript(session.actions, { source: "manual" })
  }
}

function nextActionId(): string {
  nextActionNumber += 1
  return `manual-action-${nextActionNumber}`
}

function buildFramePath(frame: WebFrameMain): string[] {
  const chain: string[] = []
  let current: WebFrameMain | null = frame
  while (current?.parent) {
    const frameUrl = current.url || current.origin || current.frameToken
    chain.unshift(`iframe[src*=${JSON.stringify(frameUrl)}]`)
    current = current.parent
  }
  return chain
}

function buildNavigationAction(url: string): AiRecordedBrowserAction {
  return {
    id: nextActionId(),
    kind: "navigate",
    source: "manual",
    timestamp: now(),
    url
  }
}

function normalizeManualEvent(
  event: ManualRecorderEvent,
  framePath: string[]
): AiRecordedBrowserAction | null {
  const timestamp = readString(event.timestamp) ?? now()
  switch (event.type) {
    case "navigate": {
      const url = readString(event.url ?? event.frameHref)
      if (!url) return null
      return {
        id: nextActionId(),
        kind: "navigate",
        source: "manual",
        timestamp,
        url
      }
    }
    case "click": {
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "click",
        source: "manual",
        timestamp,
        target: locator?.target,
        doubleClick: event.doubleClick === true,
        locator
      }
    }
    case "fill": {
      const locator = normalizeLocatorPayload(event.locator, framePath)
      const sensitive = isSensitiveTarget(locator)
      return {
        id: nextActionId(),
        kind: "fill",
        source: "manual",
        timestamp,
        target: locator?.target,
        value: sensitive ? "" : readString(event.value) ?? "",
        sensitive,
        locator
      }
    }
    case "select": {
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "selectOption",
        source: "manual",
        timestamp,
        target: locator?.target,
        values: readStringArray(event.values),
        locator
      }
    }
    case "press": {
      const key = readString(event.key)
      if (!key) return null
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "press",
        source: "manual",
        timestamp,
        key,
        target: locator?.target,
        locator
      }
    }
    case "fileUpload": {
      const paths = readStringArray(event.paths)
      if (paths.length === 0) return null
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "fileUpload",
        source: "manual",
        timestamp,
        paths,
        locator
      }
    }
    default:
      return null
  }
}

export function startManualRecording(
  options: ManualRecordingStartOptions = {}
): AiRecordingSession {
  if (activeSession?.status === "recording") return toView(activeSession)

  nextSessionNumber += 1
  activeSession = {
    id: `manual-recording-${Date.now()}-${nextSessionNumber}`,
    source: "manual",
    status: "recording",
    threadId: readString(options.threadId),
    startedAt: now(),
    actions: [],
    script: ""
  }

  const currentUrl = readString(options.currentUrl ?? undefined)
  if (currentUrl && currentUrl !== "about:blank") {
    appendAction(activeSession, buildNavigationAction(currentUrl))
  }

  lastSession = null
  return toView(activeSession)
}

export function stopManualRecording(): AiRecordingSession {
  if (!activeSession) return toView(lastSession)

  activeSession.status = "completed"
  activeSession.stoppedAt = now()
  lastSession = activeSession
  activeSession = null
  return toView(lastSession)
}

export function getManualRecording(): AiRecordingSession {
  return toView(activeSession ?? lastSession)
}

export function recordManualNavigation(url: string): void {
  if (!activeSession || activeSession.status !== "recording") return
  const nextUrl = readString(url)
  if (!nextUrl || nextUrl === "about:blank") return
  appendAction(activeSession, buildNavigationAction(nextUrl))
}

export async function installManualRecorder(frame: WebFrameMain): Promise<void> {
  if (!activeSession || activeSession.status !== "recording") return
  if (frame.isDestroyed() || frame.url.startsWith("devtools:")) return

  const script = String.raw`(() => {
    if (window.${MANUAL_RECORDER_INJECTION_FLAG}) return;
    window.${MANUAL_RECORDER_INJECTION_FLAG} = true;

    const PREFIX = ${JSON.stringify(MANUAL_RECORDER_EVENT_PREFIX)};
    const SUPPORTED_KEYS = new Set(${JSON.stringify(Array.from(SUPPORTED_PRESS_KEYS))});

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

    function emit(payload) {
      try {
        console.log(PREFIX + JSON.stringify({
          ...payload,
          timestamp: new Date().toISOString(),
          frameUrl: location.href
        }));
      } catch {}
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
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      return "";
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

    function targetForElement(element) {
      return (
        text(element.getAttribute("data-testid")) ||
        labelForElement(element) ||
        text(element.getAttribute("placeholder")) ||
        safeText(element.innerText || element.textContent, 80) ||
        text(element.getAttribute("title")) ||
        text(element.getAttribute("name"))
      );
    }

    function selectorForElement(element) {
      if (element.id) return '#' + cssEscape(element.id);
      const testId = text(element.getAttribute("data-testid"));
      if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      const name = text(element.getAttribute("name"));
      if (name) return element.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
      return element.tagName.toLowerCase();
    }

    function locatorForElement(element) {
      if (!(element instanceof Element)) return undefined;
      const tagName = element.tagName.toLowerCase();
      const role = roleForElement(element);
      const label = labelForElement(element);
      const placeholder = text(element.getAttribute("placeholder"));
      const accessibleName = label || text(element.getAttribute("aria-label")) || safeText(element.innerText || element.textContent, 80);
      const inputType = tagName === "input" ? text(element.getAttribute("type")).toLowerCase() || "text" : undefined;
      return {
        target: targetForElement(element),
        role,
        label,
        placeholder,
        testId: text(element.getAttribute("data-testid")),
        accessibleName,
        textContent: safeText(element.innerText || element.textContent, 80),
        selector: selectorForElement(element),
        tagName,
        inputType
      };
    }

    function actionableTarget(target) {
      if (!(target instanceof Element)) return null;
      return target.closest('button, a, input, textarea, select, option, [role], [tabindex]');
    }

    document.addEventListener('click', (event) => {
      const target = actionableTarget(event.target);
      if (!target) return;
      emit({ type: 'click', locator: locatorForElement(target), doubleClick: event.detail === 2 });
    }, true);

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
      if (target instanceof HTMLSelectElement) {
        emit({
          type: 'select',
          locator: locatorForElement(target),
          values: Array.from(target.selectedOptions).map((option) => text(option.value) || safeText(option.textContent, 80)).filter(Boolean)
        });
        return;
      }

      if (target instanceof HTMLInputElement && target.type === 'file') {
        const paths = Array.from(target.files ?? [])
          .map((file) => {
            const path = text(file?.path);
            return path || text(file?.webkitRelativePath) || text(file?.name);
          })
          .filter(Boolean);
        if (paths.length === 0) {
          const inputValue = text(target.value);
          if (inputValue) paths.push(inputValue);
        }
        if (paths.length > 0) {
          emit({ type: 'fileUpload', locator: locatorForElement(target), paths });
        }
        return;
      }

      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
        return;
      }

      emit({ type: 'fill', locator: locatorForElement(target), value: target.value });
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!SUPPORTED_KEYS.has(event.key)) return;
      const target = event.target instanceof Element ? actionableTarget(event.target) : null;
      emit({ type: 'press', key: event.key, locator: target ? locatorForElement(target) : undefined });
    }, true);

    window.addEventListener('hashchange', () => {
      emit({ type: 'navigate', url: location.href });
    });
  })();`

  try {
    await frame.executeJavaScript(script)
  } catch {
    // Cross-origin or transient frames may reject injection; ignore and keep recording other frames.
  }
}

export async function installManualRecorderForSubtree(frame: WebFrameMain): Promise<void> {
  const frames = frame.framesInSubtree
  for (const child of frames) {
    await installManualRecorder(child)
  }
}

export function recordManualRecorderConsoleMessage(frame: WebFrameMain, message: string): void {
  if (!activeSession || activeSession.status !== "recording") return
  if (!message.startsWith(MANUAL_RECORDER_EVENT_PREFIX)) return

  let parsed: ManualRecorderEvent
  try {
    parsed = JSON.parse(message.slice(MANUAL_RECORDER_EVENT_PREFIX.length)) as ManualRecorderEvent
  } catch {
    return
  }

  const action = normalizeManualEvent(parsed, buildFramePath(frame))
  if (!action) return
  appendAction(activeSession, action)
}

export function resetManualRecordingForTests(): void {
  activeSession = null
  lastSession = null
  nextSessionNumber = 0
  nextActionNumber = 0
}
