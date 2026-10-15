# Group composer source references

The group editor adapts the user-provided Grok Bot reconstructed frontend:

- `grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx`
- `promptEditorContent`, `serializePromptNode`, `PromptMention`, `createPromptEditorExtensions`, and `PromptRichTextEditor`

It uses the same Tiptap 3.14.0 editor primitives, inline atom model, native history,
plain-text serialization, and controlled external content synchronization. Only
document/paragraph/text/hard-break/history/placeholder functionality is loaded;
workflow, PR, emoji, global clipboard, model, and service integration are omitted.

CMB-specific adapters connect the editor to the existing `text + mentions` draft,
member ID validation, attachment handler, and `BotMentionLabel` avatar rendering.
No rich-text JSON or second draft is persisted. Pasted labels do not create bound
recipient IDs. The original workbench composer and Agent Runtime are unchanged
by this editor adaptation.

Tiptap and ProseMirror retain their own package licenses. This note records source
provenance and does not assign a license to the reconstructed Grok source.
