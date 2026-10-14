import {
  cumulativePromptEdit,
  validatePromptEditResult,
  type FunctionPromptBox,
  type FunctionPromptDecoration,
  type FunctionPromptEditInput,
  type FunctionPromptEditResult,
  type FunctionPromptKey
} from "../../../shared/mods/v2/prompt-edit"

/** Private editor facts. None of these ownership or CAS fields enter a Mod's event. */
export type PromptEditSnapshot = {
  owner: string
  revision: number
  text: string
  cursor: number
  selectionStart: number
  selectionEnd: number
  selectionDirection: "forward" | "backward" | "none"
  composing: boolean
  available: boolean
}
type Pending = {
  token: number
  snapshot: PromptEditSnapshot
  input: FunctionPromptEditInput
  controller: AbortController
  promise?: Promise<FunctionPromptEditResult>
}

export function samePromptEditSnapshot(
  left: PromptEditSnapshot,
  right: PromptEditSnapshot
): boolean {
  return (
    left.owner === right.owner &&
    left.revision === right.revision &&
    left.text === right.text &&
    left.cursor === right.cursor &&
    left.selectionStart === right.selectionStart &&
    left.selectionEnd === right.selectionEnd &&
    left.selectionDirection === right.selectionDirection &&
    left.composing === right.composing &&
    left.available === right.available
  )
}

/** Optimistic text is never promoted to the confirmed baseline merely by typing again. */
export class PromptEditController {
  private confirmed: FunctionPromptBox
  private pending?: Pending
  private sequence = 0
  private closed = false
  private submission?: Pending
  private deferred?: PromptEditSnapshot
  decorations: FunctionPromptDecoration[] = []
  constructor(
    private readonly options: {
      initial: PromptEditSnapshot
      read(): PromptEditSnapshot
      dispatch(
        input: FunctionPromptEditInput,
        token: number,
        signal: AbortSignal,
        nativeCursor: number
      ): Promise<FunctionPromptEditResult>
      apply(expected: PromptEditSnapshot, result: FunctionPromptEditResult): boolean
    }
  ) {
    this.confirmed = { text: options.initial.text, cursor: options.initial.cursor }
  }
  change(
    snapshot: PromptEditSnapshot,
    key?: FunctionPromptKey,
    native?: FunctionPromptEditInput
  ): void {
    if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
    if (this.submission) {
      this.deferred = { ...snapshot }
      return
    }
    const previous = this.pending
    previous?.controller.abort()
    const token = ++this.sequence
    this.pending = {
      token,
      snapshot: { ...snapshot },
      controller: new AbortController(),
      input:
        !previous && native?.text === this.confirmed.text
          ? native
          : cumulativePromptEdit(this.confirmed, snapshot, previous ? undefined : key)
    }
  }
  /** Called only for a trusted programmatic fill/restored draft, never for native typing. */
  reset(snapshot: PromptEditSnapshot, decorations: FunctionPromptDecoration[] = []): void {
    this.pending?.controller.abort()
    this.pending = undefined
    this.confirmed = { text: snapshot.text, cursor: snapshot.cursor }
    this.decorations = decorations
  }
  get isPending(): boolean {
    return this.pending !== undefined
  }
  /** Reserve the Enter-time edit; subsequent typing is validated only after this request. */
  async flushSubmission(
    snapshot: PromptEditSnapshot
  ): Promise<FunctionPromptBox & { revision: number }> {
    if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
    if (this.submission) throw Error("MODS_PROMPT_SUBMISSION_PENDING")
    if (
      !snapshot.available ||
      snapshot.composing ||
      !this.options.read().available ||
      this.options.read().owner !== snapshot.owner
    )
      throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
    if (this.pending && !samePromptEditSnapshot(this.pending.snapshot, snapshot))
      this.change(snapshot)
    if (!this.pending && snapshot.text !== this.confirmed.text) this.change(snapshot)
    if (!this.pending)
      return { text: snapshot.text, cursor: snapshot.cursor, revision: snapshot.revision }
    const request = this.pending
    this.submission = request
    try {
      request.promise ??= this.options.dispatch(
        request.input,
        request.token,
        request.controller.signal,
        snapshot.cursor
      )
      const result = await request.promise
      request.controller.signal.throwIfAborted()
      if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
      validatePromptEditResult(result)
      const latest = this.options.read()
      if (latest.owner !== snapshot.owner || !latest.available)
        throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
      const applied =
        samePromptEditSnapshot(snapshot, latest) && this.options.apply(snapshot, result)
      if (applied) {
        this.confirmed = { text: result.text, cursor: result.cursor }
        this.decorations = result.decorations ?? []
      }
      this.pending = undefined
      return {
        text: result.text,
        cursor: result.cursor,
        revision: applied ? this.options.read().revision : snapshot.revision
      }
    } finally {
      this.submission = undefined
      if (this.pending === request)
        this.pending = {
          ...request,
          token: ++this.sequence,
          controller: new AbortController(),
          promise: undefined
        }
      const deferred = this.deferred
      this.deferred = undefined
      if (deferred && !this.closed) this.change(deferred)
    }
  }
  async flush(): Promise<FunctionPromptBox> {
    if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
    while (this.pending) {
      const current = this.pending
      if (current.snapshot.composing || this.options.read().composing)
        throw Error("MODS_PROMPT_EDIT_COMPOSING")
      if (!current.snapshot.available) throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
      try {
        current.promise ??= this.options.dispatch(
          current.input,
          current.token,
          current.controller.signal,
          current.snapshot.cursor
        )
        const result = await current.promise
        if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
        if (this.submission === current) {
          validatePromptEditResult(result)
          return { text: result.text, cursor: result.cursor }
        }
        if (this.pending !== current) continue
        validatePromptEditResult(result)
        if (
          !samePromptEditSnapshot(current.snapshot, this.options.read()) ||
          !this.options.apply(current.snapshot, result)
        )
          throw Error("MODS_PROMPT_EDIT_CONFLICT")
        this.confirmed = { text: result.text, cursor: result.cursor }
        this.decorations = result.decorations ?? []
        this.pending = undefined
      } catch (error) {
        if (this.closed) throw Error("MODS_PROMPT_EDITOR_CLOSED")
        if (this.submission === current) throw error
        if (this.pending !== current) continue
        // A new user send may retry explicitly, with a fresh request identity. No auto replay.
        this.pending = {
          ...current,
          token: ++this.sequence,
          controller: new AbortController(),
          promise: undefined
        }
        throw error
      }
    }
    const latest = this.options.read()
    if (!latest.available || latest.composing) throw Error("MODS_PROMPT_EDITOR_UNAVAILABLE")
    if (latest.text !== this.confirmed.text) throw Error("MODS_PROMPT_EDIT_UNCONFIRMED")
    return { text: latest.text, cursor: latest.cursor }
  }
  close(): void {
    this.closed = true
    this.pending?.controller.abort()
    this.pending = undefined
  }
}
