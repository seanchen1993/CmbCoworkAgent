import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import {
  fillPromptSnapshot,
  validPromptSnapshot,
  type PromptComposerSnapshot,
  type PromptComposerResponse
} from "../../../shared/mods/v2/prompt-composer"
import type {
  FunctionPromptBox,
  FunctionPromptDecoration,
  FunctionPromptKey,
  FunctionPromptEditInput
} from "../../../shared/mods/v2/prompt-edit"
import {
  PromptEditController,
  samePromptEditSnapshot,
  type PromptEditSnapshot
} from "./prompt-edit-controller"
import { movePromptDecorations } from "./prompt-decoration"

type Editor = {
  readonly threadId: string
  changed(): void
  composition(value: boolean): void
  reset(): void
  clearSuggestion(): void
  acceptSuggestion(): boolean
  flush(): Promise<FunctionPromptBox & { revision: number }>
  captureSubmission(): PromptEditSnapshot
  flushSubmission(intent: PromptEditSnapshot): Promise<FunctionPromptBox & { revision: number }>
  isConfirmed(draft: { text: string; revision: number }): boolean
  isSubmissionConfirmed(draft: { text: string; revision: number }): boolean
}

/** Only the mounted text composer crosses IPC; attachments and selection chips stay private. */
export function usePromptComposer(options: {
  threadId: string
  enabled: boolean
  textarea: RefObject<HTMLTextAreaElement | null>
  read(): { text: string; revision: number }
  apply(expectedRevision: number, text: string): boolean
  onError?(message: string): void
  working?: boolean
}) {
  const { threadId, enabled, textarea } = options
  const current = useRef(options)
  useLayoutEffect(() => {
    current.current = options
  })
  const editor = useRef<Editor | null>(null)
  const [paint, setPaint] = useState<{ text: string; decorations: FunctionPromptDecoration[] }>({
    text: "",
    decorations: []
  })
  const [suggestion, setSuggestion] = useState("")
  useEffect(() => {
    if (!enabled) return
    const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    let alive = true,
      serial = 0,
      lastRevision = -1,
      lastCursor = -1,
      lastSelection = "",
      wireSequence = 0,
      composing = false,
      applying = false,
      observedRevision = current.current.read().revision,
      controller: PromptEditController | undefined,
      key: FunctionPromptKey | undefined,
      debounce: ReturnType<typeof setTimeout> | undefined,
      queryGeneration = 0,
      lastEdit: PromptEditSnapshot | undefined
    let submissionReceipt:
      | { draft: { text: string; revision: number }; generation: number }
      | undefined
    let submissionSnapshot: PromptEditSnapshot | undefined
    let validated: PromptEditSnapshot | undefined
    let ghost: { text: string; snapshot: PromptEditSnapshot } | undefined
    let nativeBefore:
      | { text: string; cursor: number; start: number; end: number; inputType: string }
      | undefined
    let ready: Promise<void>
    const ownsComposer = () =>
      alive &&
      editor.current === handle &&
      current.current.threadId === threadId &&
      current.current.enabled
    const assertComposer = () => {
      if (!ownsComposer()) throw Error("MODS_PROMPT_EDITOR_CLOSED")
    }
    const snapshot = (): {
      status: PromptComposerResponse["status"]
      value: PromptComposerSnapshot
      storeRevision: number
    } => {
      const node = textarea.current,
        draft = current.current.read()
      const cursor = node
        ? node.selectionDirection === "backward"
          ? node.selectionStart
          : node.selectionEnd
        : 0
      const selection = node
        ? `${node.selectionStart}:${node.selectionEnd}:${node.selectionDirection}`
        : ""
      if (draft.revision !== lastRevision || cursor !== lastCursor || selection !== lastSelection) {
        serial++
        lastRevision = draft.revision
        lastCursor = cursor
        lastSelection = selection
      }
      const value = { text: draft.text, cursor, revision: serial }
      const unavailable =
        !ownsComposer() ||
        !node?.isConnected ||
        node.disabled ||
        !node.getClientRects().length ||
        node.value !== draft.text ||
        !validPromptSnapshot(value)
      const dialog = Boolean(
        document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')
      )
      return {
        status: unavailable ? "no_composer" : dialog ? "dialog" : "ok",
        value,
        storeRevision: draft.revision
      }
    }
    const editSnapshot = (): PromptEditSnapshot => {
      const state = snapshot(),
        node = textarea.current
      return {
        owner,
        revision: state.storeRevision,
        text: state.value.text,
        cursor: state.value.cursor,
        selectionStart: node?.selectionStart ?? 0,
        selectionEnd: node?.selectionEnd ?? 0,
        selectionDirection: node?.selectionDirection ?? "none",
        composing,
        available: state.status === "ok"
      }
    }
    const writeBox = (revision: number, box: FunctionPromptBox): boolean => {
      if (!ownsComposer()) return false
      if (!current.current.apply(revision, box.text)) return false
      const target = textarea.current
      if (!target) return false
      const before = {
        text: target.value,
        start: target.selectionStart,
        cursor:
          target.selectionDirection === "backward" ? target.selectionStart : target.selectionEnd,
        end: target.selectionEnd,
        direction: target.selectionDirection
      }
      applying = true
      try {
        target.value = box.text
        if (box.text === before.text && box.cursor === before.cursor)
          target.setSelectionRange(before.start, before.end, before.direction)
        else target.setSelectionRange(box.cursor, box.cursor)
        observedRevision = current.current.read().revision
        lastEdit = editSnapshot()
      } finally {
        applying = false
      }
      return true
    }
    const report = (cause: unknown) => {
      if (ownsComposer() && !composing)
        current.current.onError?.(
          `输入规则未完成，内容已保留，请重试。${cause instanceof Error ? cause.message : String(cause)}`
        )
    }
    const schedule = () => {
      clearTimeout(debounce)
      if (composing || !controller || submissionSnapshot) return
      debounce = setTimeout(() => {
        const pending = ready
        void handle.flush().catch((cause) => {
          if (
            pending === ready &&
            !submissionSnapshot &&
            !(cause instanceof Error && cause.message === "MODS_PROMPT_SUBMISSION_PENDING")
          )
            report(cause)
        })
      }, 45)
    }
    const refresh = async () => {
      if (!ownsComposer()) return
      const generation = ++queryGeneration
      handle.clearSuggestion()
      controller?.close()
      controller = undefined
      validated = undefined
      setPaint({ text: "", decorations: [] })
      // Old test/client builds have no edit endpoint. Current preload always exposes it.
      if (!window.api.mods.promptEditSupport) return
      let required: boolean
      try {
        required = await window.api.mods.promptEditSupport(threadId, owner)
      } catch (error) {
        if (!ownsComposer() || generation !== queryGeneration) return
        throw error
      }
      if (!ownsComposer() || generation !== queryGeneration || !required) return
      const initial = submissionSnapshot ?? editSnapshot()
      // A draft typed before discovery still has to pass the newly active rules.
      controller = new PromptEditController({
        initial: { ...initial, text: "", cursor: 0 },
        read: editSnapshot,
        dispatch: async (input, _token, signal, nativeCursor) => {
          const sequence = ++wireSequence
          const cancel = () => {
            void window.api.mods.promptEditCancel(threadId, owner, sequence).catch(() => undefined)
          }
          signal.throwIfAborted()
          signal.addEventListener("abort", cancel, { once: true })
          try {
            return await window.api.mods.promptEdit({
              threadId,
              owner,
              sequence,
              input,
              nativeCursor
            })
          } finally {
            signal.removeEventListener("abort", cancel)
          }
        },
        apply: (expected, result) => {
          if (
            !alive ||
            !samePromptEditSnapshot(expected, editSnapshot()) ||
            !writeBox(expected.revision, result)
          )
            return false
          setPaint({ text: result.text, decorations: result.decorations ?? [] })
          return true
        }
      })
      if (initial.text || initial.cursor) controller.change(initial)
      lastEdit = initial
      schedule()
    }
    const handle: Editor = {
      threadId,
      changed() {
        validated = undefined
        handle.clearSuggestion()
        observedRevision = current.current.read().revision
        if (submissionSnapshot) {
          nativeBefore = undefined
          key = undefined
          return
        }
        if (!controller) {
          key = undefined
          return
        }
        const state = editSnapshot()
        lastEdit = state
        let native: FunctionPromptEditInput | undefined
        if (nativeBefore && !composing) {
          const before = nativeBefore
          let start = before.start,
            end = before.end
          if (
            start === end &&
            before.inputType.startsWith("delete") &&
            state.text.length < before.text.length
          ) {
            const removed = before.text.length - state.text.length
            if (before.inputType.includes("Backward")) start = Math.max(0, start - removed)
            else if (before.inputType.includes("Forward"))
              end = Math.min(before.text.length, end + removed)
          }
          const length = state.text.length - before.text.length + end - start
          const inputText = length >= 0 ? state.text.slice(start, start + length) : ""
          if (
            length >= 0 &&
            before.text.slice(0, start) + inputText + before.text.slice(end) === state.text
          )
            native = {
              origin: { kind: "composer" },
              text: before.text,
              cursor: before.cursor,
              start,
              end,
              inputText,
              ...(key ? { key } : {})
            }
        }
        nativeBefore = undefined
        setPaint((before) => ({
          text: state.text,
          decorations: movePromptDecorations(before.text, state.text, before.decorations, native)
        }))
        try {
          controller.change(state, composing ? undefined : key, native)
        } catch (cause) {
          report(cause)
        }
        key = undefined
        schedule()
      },
      composition(value) {
        composing = value
        key = undefined
        clearTimeout(debounce)
        if (value) handle.changed()
        else
          queueMicrotask(() => {
            if (alive) handle.changed()
          })
      },
      reset() {
        validated = undefined
        handle.clearSuggestion()
        const draft = current.current.read(),
          node = textarea.current
        // React may not have committed a consumed/template draft to the DOM yet.
        // Reset must not pair its new text with the old textarea's out-of-range cursor.
        if (node && node.value !== draft.text)
          writeBox(draft.revision, {
            text: draft.text,
            cursor: Math.min(node.selectionStart, draft.text.length)
          })
        observedRevision = current.current.read().revision
        controller?.reset(editSnapshot())
        lastEdit = editSnapshot()
        setPaint({ text: "", decorations: [] })
      },
      clearSuggestion() {
        ghost = undefined
        setSuggestion("")
      },
      isConfirmed(draft) {
        return (
          alive &&
          !controller?.isPending &&
          Boolean(
            validated &&
            draft.text === validated.text &&
            draft.revision === validated.revision &&
            samePromptEditSnapshot(validated, editSnapshot())
          )
        )
      },
      acceptSuggestion() {
        const before = ghost,
          state = editSnapshot()
        if (
          !before ||
          composing ||
          current.current.working ||
          !state.available ||
          !samePromptEditSnapshot(before.snapshot, state)
        )
          return false
        handle.clearSuggestion()
        if (!writeBox(state.revision, { text: before.text, cursor: before.text.length }))
          return false
        // Accepting a proposal is a real optimistic edit, never a trusted reset or auto-send.
        handle.changed()
        return true
      },
      isSubmissionConfirmed(draft) {
        return (
          ownsComposer() &&
          submissionReceipt?.draft === draft &&
          submissionReceipt.generation === queryGeneration
        )
      },
      captureSubmission: editSnapshot,
      async flushSubmission(intent) {
        if (submissionSnapshot) throw Error("MODS_PROMPT_SUBMISSION_PENDING")
        submissionReceipt = undefined
        const captured = { ...intent, owner }
        submissionSnapshot = captured
        clearTimeout(debounce)
        try {
          while (ownsComposer()) {
            const pending = ready
            const original = controller
            // Reserve an already-running rule before the first await. New native
            // edits cannot cancel it through the broker's per-editor sequence.
            const reserved = original?.flushSubmission(captured)
            void reserved?.catch(() => undefined)
            try {
              await pending
              assertComposer()
              if (pending !== ready || (original && original !== controller)) continue
              const result = reserved
                ? await reserved
                : controller
                  ? await controller.flushSubmission(captured)
                  : { text: captured.text, cursor: captured.cursor, revision: captured.revision }
              assertComposer()
              if (pending !== ready) continue
              if (!captured.available || captured.composing || !editSnapshot().available)
                throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
              submissionReceipt = { draft: result, generation: queryGeneration }
              return result
            } catch (cause) {
              assertComposer()
              if (pending !== ready || (original && original !== controller)) continue
              throw cause
            }
          }
          throw Error("MODS_PROMPT_EDITOR_CLOSED")
        } finally {
          submissionSnapshot = undefined
          if (ownsComposer() && (!lastEdit || !samePromptEditSnapshot(lastEdit, editSnapshot())))
            handle.changed()
        }
      },
      async flush() {
        clearTimeout(debounce)
        while (ownsComposer()) {
          const pending = ready
          try {
            await pending
          } catch (error) {
            assertComposer()
            if (pending !== ready) continue
            throw error
          }
          assertComposer()
          if (pending !== ready) continue
          if (composing) throw Error("MODS_PROMPT_EDIT_COMPOSING")
          // Follow-ups and templates can retain unconfirmed text. Reconcile the entire
          // change instead of promoting it. Only explicit fill/consumed drafts reset.
          if (
            current.current.read().revision !== observedRevision ||
            (controller && (!lastEdit || !samePromptEditSnapshot(lastEdit, editSnapshot())))
          )
            handle.changed()
          if (submissionSnapshot) throw Error("MODS_PROMPT_SUBMISSION_PENDING")
          const active = controller
          let box: FunctionPromptBox
          try {
            box = active
              ? await active.flush()
              : { text: current.current.read().text, cursor: textarea.current?.selectionStart ?? 0 }
          } catch (error) {
            assertComposer()
            if (ready !== pending || active !== controller) continue
            throw error
          }
          assertComposer()
          if (submissionSnapshot) throw Error("MODS_PROMPT_SUBMISSION_PENDING")
          if (ready !== pending || active !== controller || controller?.isPending) continue
          const latest = editSnapshot()
          if (latest.text !== box.text) continue
          if (!latest.available || latest.composing) throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
          validated = latest
          return { ...box, revision: latest.revision }
        }
        throw Error("MODS_PROMPT_EDITOR_CLOSED")
      }
    }
    editor.current = handle
    const onSelect = () => {
      snapshot()
      if (
        !applying &&
        controller &&
        (!lastEdit || !samePromptEditSnapshot(lastEdit, editSnapshot()))
      )
        handle.changed()
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        composing ||
        event.altKey ||
        ["Shift", "Control", "Meta", "Alt"].includes(event.key) ||
        (event.key === "Enter" && !event.shiftKey)
      ) {
        key = undefined
        return
      }
      const names: Record<string, string> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        Backspace: "backspace",
        Delete: "delete",
        Home: "home",
        End: "end",
        PageUp: "pageup",
        PageDown: "pagedown",
        Tab: "tab",
        Escape: "escape",
        Enter: "return"
      }
      key = {
        key: names[event.key] ?? event.key,
        ...(event.ctrlKey ? { ctrl: true } : {}),
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.metaKey ? { meta: true } : {})
      }
    }
    const onBeforeInput = (event: Event) => {
      const type = (event as InputEvent).inputType
      const genuineKey =
        type === "insertText" ||
        (type.startsWith("delete") &&
          type !== "deleteByCut" &&
          (key?.key === "backspace" || key?.key === "delete")) ||
        (["insertLineBreak", "insertParagraph"].includes(type) && key?.key === "return")
      if (!genuineKey) key = undefined
      const node = textarea.current
      nativeBefore =
        node && !composing
          ? {
              text: node.value,
              cursor:
                node.selectionDirection === "backward" ? node.selectionStart : node.selectionEnd,
              start: node.selectionStart,
              end: node.selectionEnd,
              inputType: (event as InputEvent).inputType
            }
          : undefined
    }
    const node = textarea.current
    const onPointer = () => {
      key = undefined
      nativeBefore = undefined
    }
    node?.addEventListener("select", onSelect)
    node?.addEventListener("keydown", onKey)
    node?.addEventListener("beforeinput", onBeforeInput)
    node?.addEventListener("pointerdown", onPointer)
    node?.addEventListener("blur", onPointer)
    const stop = window.api.mods.onPromptRequest(async (request) => {
      if (request.threadId !== threadId || request.owner !== owner) return
      const generation = queryGeneration
      if (request.kind !== "read") {
        const authorized = await window.api.mods
          .promptAuthorize(threadId, owner, request.requestId)
          .catch(() => false)
        if (!authorized || !alive || generation !== queryGeneration) return
      }
      if (request.kind === "fill" && request.mode !== "replace" && controller?.isPending) {
        // This fill may come from the very edit hook that flush is waiting for.
        // Refuse the unconfirmed baseline immediately rather than await ourselves.
        const state = snapshot()
        void window.api.mods
          .promptRespond({
            requestId: request.requestId,
            threadId,
            owner,
            status: "conflict",
            ...state.value
          })
          .catch(() => undefined)
        return
      }
      const state = snapshot()
      let status = state.status,
        value = state.value
      let isShown: boolean | undefined
      if (request.kind === "suggest") {
        isShown = false
        const edit = editSnapshot()
        if (
          (status === "ok" || status === "dialog") &&
          !composing &&
          !current.current.working &&
          !edit.text &&
          request.text?.trim() &&
          (request.expectedRevision === undefined ||
            request.expectedRevision === state.value.revision)
        ) {
          ghost = { text: request.text, snapshot: { ...edit, available: true } }
          setSuggestion(status === "ok" ? request.text : "")
          isShown = true
          status = "ok"
        }
      }
      if (request.kind === "fill" && status === "ok") {
        if (request.expectedRevision !== state.value.revision) status = "conflict"
        else {
          try {
            const next = fillPromptSnapshot(
              state.value,
              request.text ?? "",
              request.mode ?? "replace"
            )
            if (!writeBox(state.storeRevision, next)) status = "conflict"
            else {
              handle.reset()
              if (request.decorations) {
                const offset =
                  request.mode === "append"
                    ? state.value.text.length
                    : request.mode === "insert"
                      ? state.value.cursor
                      : 0
                const decorations = request.decorations.map((span) => ({
                  ...span,
                  start: Math.max(0, Math.min(request.text?.length ?? 0, span.start)) + offset,
                  end: Math.max(0, Math.min(request.text?.length ?? 0, span.end)) + offset
                }))
                controller?.reset(editSnapshot(), decorations)
                setPaint({ text: next.text, decorations })
              }
              value = snapshot().value
            }
          } catch {
            status = "conflict"
          }
        }
      }
      // A dialog hides draft text, but suggestions still need a private CAS stamp.
      // This revision never enters the plugin-visible prompt.read result.
      const visible =
        status === "ok" || status === "conflict"
          ? value
          : { text: "", cursor: 0, revision: status === "dialog" ? state.value.revision : 0 }
      void window.api.mods
        .promptRespond({
          requestId: request.requestId,
          threadId,
          owner,
          status,
          ...visible,
          ...(isShown === undefined ? {} : { isShown })
        })
        .catch(() => undefined)
    })
    const stopChange = window.api.mods.onConfigurationChanged?.(() => {
      if (!ownsComposer()) return
      ++queryGeneration
      handle.clearSuggestion()
      controller?.close()
      ready = ready.catch(() => undefined).then(refresh)
      const pending = ready
      void pending.catch((cause) => {
        if (pending === ready) report(cause)
      })
    })
    ready = window.api.mods.promptAttach(threadId, owner).then(refresh)
    const initialReady = ready
    void initialReady.catch((cause) => {
      if (initialReady === ready) report(cause)
    })
    const dialogObserver = new MutationObserver(() => {
      if (!ghost) return
      const state = editSnapshot()
      if (
        state.text ||
        current.current.working ||
        state.composing ||
        state.owner !== ghost.snapshot.owner ||
        state.revision !== ghost.snapshot.revision
      )
        handle.clearSuggestion()
      else setSuggestion(state.available ? ghost.text : "")
    })
    dialogObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "role", "disabled"]
    })
    return () => {
      alive = false
      clearTimeout(debounce)
      controller?.close()
      dialogObserver.disconnect()
      setSuggestion("")
      if (editor.current === handle) editor.current = null
      stop()
      stopChange?.()
      node?.removeEventListener("select", onSelect)
      node?.removeEventListener("keydown", onKey)
      node?.removeEventListener("beforeinput", onBeforeInput)
      node?.removeEventListener("pointerdown", onPointer)
      node?.removeEventListener("blur", onPointer)
      void window.api.mods.promptDetach(threadId, owner).catch(() => undefined)
    }
  }, [threadId, enabled, textarea])
  useEffect(() => {
    if (options.working) editor.current?.clearSuggestion()
  }, [options.working])
  return {
    decorations: enabled ? paint.decorations : [],
    suggestion: enabled && !options.working ? suggestion : "",
    acceptSuggestion: () => editor.current?.acceptSuggestion() ?? false,
    changed: () => editor.current?.changed(),
    composition: (value: boolean) => editor.current?.composition(value),
    reset: () => editor.current?.reset(),
    isConfirmed: (draft: { text: string; revision: number }) =>
      editor.current
        ? editor.current.isConfirmed(draft)
        : draft.text === current.current.read().text &&
          draft.revision === current.current.read().revision,
    isSubmissionConfirmed: (draft: { text: string; revision: number }) =>
      editor.current?.isSubmissionConfirmed(draft) ?? false,
    flushSubmission: async () => {
      let active = editor.current
      if (!active || active.threadId !== threadId) throw Error("MODS_PROMPT_EDITOR_CLOSED")
      const intent = active.captureSubmission()
      while (true) {
        try {
          return await active.flushSubmission(intent)
        } catch (cause) {
          const next = editor.current
          if (
            !next ||
            next === active ||
            next.threadId !== threadId ||
            current.current.threadId !== threadId ||
            !current.current.enabled
          )
            throw cause
          // A remounted editor validates the same Enter-time text under its own lease.
          active = next
        }
      }
    },
    flush: async () => {
      const initial = editor.current
      if (!initial) {
        if (current.current.threadId !== threadId || current.current.enabled)
          throw Error("MODS_PROMPT_EDITOR_CLOSED")
        return { ...current.current.read(), cursor: textarea.current?.selectionStart ?? 0 }
      }
      let active: Editor = initial
      while (true) {
        if (
          current.current.threadId !== threadId ||
          !current.current.enabled ||
          active.threadId !== threadId
        )
          throw Error("MODS_PROMPT_EDITOR_CLOSED")
        try {
          const result = await active.flush()
          if (
            editor.current === active &&
            current.current.threadId === threadId &&
            current.current.enabled
          )
            return result
        } catch (error) {
          const next = editor.current
          if (
            !next ||
            next === active ||
            next.threadId !== threadId ||
            current.current.threadId !== threadId ||
            !current.current.enabled
          )
            throw error
        }
        const next = editor.current
        if (
          !next ||
          next === active ||
          next.threadId !== threadId ||
          current.current.threadId !== threadId ||
          !current.current.enabled
        )
          throw Error("MODS_PROMPT_EDITOR_CLOSED")
        // This is still the person's unsent submission. A retired editor never continues;
        // the new mounted editor validates the current draft using its own original lease.
        active = next
      }
    }
  }
}
