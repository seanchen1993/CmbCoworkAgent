# Group composer source references

The group editor adapts the user-provided Grok Bot reconstructed frontend:

- `grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx`
- `promptEditorContent`, `serializePromptNode`, `PromptMention`, `createPromptEditorExtensions`, `PromptRichTextEditor`, `ScrollCaretIntoView`, and `MacEmacsLineMotion`

It uses the same Tiptap 3.14.0 editor primitives, inline atom model, native history,
plain-text serialization, caret visibility, Mac line navigation, and controlled external content synchronization. Only
document/paragraph/text/hard-break/history/placeholder functionality is loaded;
workflow, PR, emoji, global clipboard, model, and service integration are omitted.

CMB-specific adapters connect the editor to the existing `text + mentions` draft,
member ID validation, attachment handler, and `BotMentionLabel` avatar rendering.
No rich-text JSON or second draft is persisted. Pasted labels do not create bound
recipient IDs. The original workbench composer and Agent Runtime are unchanged
by this editor adaptation.

The CMB group editor supplies ProseMirror's `clipboardTextParser` using the same
plain-prompt document builder. This preserves empty paragraphs that the library's
default text parser merges, while retaining native selection replacement and
undo/redo. CRLF/CR line endings become LF; pasted labels remain unbound text.
This is a CMB integration fix, not a copied Grok clipboard parser.

Escape handling follows Grok's editor-level `handleKeyDown` callback, before
ProseMirror's default Escape capture prevents the outer form handler. Mention
candidates consume Escape first; otherwise the existing composer cancels its
reply draft. Composition guards and the original draft store remain in use.

Tiptap and ProseMirror retain their own package licenses. This note records source
provenance and does not assign a license to the reconstructed Grok source.

## Inline question presentation

`BotQuestionInput` follows the installed Grok Bot 0.71.2 renderer's
`chunk-widget-BhFzp8Ld.js` (`Ue`, `It`, `Tt`): inline question headings,
lettered options, direct single-choice responses, custom answers, explicit dismissal,
and compact settled receipts. It adapts those interactions to CMB's existing
multi-question request and supplementary-answer contract. Request drafts, response
serialization, deadlines and transport remain owned by `UserInputRequestDialog`
and the original runtime; no Grok service protocol or second message store is used.

Stopped questions use CMB's existing Bot task ownership and `botToolResultStatus`
cancellation-receipt recognition. Missing results alone are not treated as cancellation;
actual submitted answers and inspectable execution records remain intact.

Bot profile editor focus restoration reuses CMB `SettingsOverlay` and
`BotSchedulePanel` (`onCloseAutoFocus` with a connected opener). The recovered
Grok `sand-floating-primitives.tsx` uses the same connected-opener check and
`focus({ preventScroll: true })`; menu-opened editing returns to the persistent
menu trigger, while direct role editing returns to its own button. No shared
dialog or additional focus listener is introduced.

The private-memory sharing recipient picker reuses CMB's existing Radix Select,
as BotEditor and BotSchedulePanel already do. The recovered Grok
`sand-floating-primitives.tsx` (`SandSelect`) and its CSS inform the bounded,
rounded in-app popup, selected/hover state, Escape dismissal and return to the
trigger. No Grok popup implementation is copied and no shared primitive is
changed. Recipient IDs, memory versions and copying remain with the existing
Bot memory service.

The sidebar footer follows installed Grok Bot 0.71.2's `bD`, `mD` and `pD`
components: a round profile entry, a text pill when expanded, and a storefront
button on the collapsed rail. The profile name and account page reuse CMB's
`models.getUserInfo`, `notify-login-msg` subscription and `UserInfoPanel`.
Hidden/archived views, theme preferences and connector opening retain their
existing owners. Menu surfaces use the existing Bot palette and Radix motion.

`BotStorefrontIcon` is the single `storefront` outline glyph (U+F483) from that
client's `cursor-icons-16-gwXtdAvu.woff2`, SHA-256
`3887767ecc6d7ac4ec8f5f1bfe7133a2e1b83a0992bf3211abb1f3680696054a`.
Its original 300-unit outline and 16px display size are retained as inline SVG.

The Bot file-preview shell follows installed 0.71.2's `Ee` / `le` in
`chunk-table-loader-CHDxCAMF.js`: 40px viewport margins, a 1100px maximum width,
12px corners, a half-pixel border, and a compact 14px title. It keeps CMB's
existing Dialog, FileViewer, preview transport, saving and focus restoration.
Palette variables are scoped to this portaled Bot dialog so its Markdown/table
styles do not inherit the workbench's accent. The existing workbench preview
and its default file presentation are unchanged.

The Bot JSON preview adapts the installed 0.71.2
`chunk-fullscreen-file-viewer-body-BJijlGrd.js` pure tree model (`sa`, `aa`, `Dt`)
and `En` presentation: two expanded levels, ordinal node identities, a 200-child
limit, descendant expansion reset, container summaries, and Tab between carets.
Row spacing follows its 16px caret / 17px nesting / 22px baseline and 12px mono
text, an 860px padded content width, and hover-visible scrollbars.
The installed client's `Mn` uses the shared `za` scroll area without an explicit
`viewportTabIndex`. Virtuoso's additional default scroll-container tab stop is
removed with `tabIndex={-1}`; the tree carets keep their native button focus.
CMB's existing react-virtuoso handles variable-height virtualization;
Grok's custom layout, frame measurement and selection framework are not copied.
Unlike a numeric JSON.parse round trip, number leaves retain their original
source lexemes. Parsing and expansion use a preview-scoped Vite Worker following
CMB's existing code-highlight worker pattern; only display rows cross to React,
and switching or closing the document terminates the worker. The optional FileViewer adapter reuses its existing bounded
assembly, permissions, cancellation and cache; invalid or incomplete JSON uses
the original CodeViewer. Hermes's json-document-editor is an in-memory editor,
so it is not reused for an on-disk preview.
