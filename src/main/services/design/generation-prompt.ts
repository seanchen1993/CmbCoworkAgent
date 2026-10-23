export const DESIGN_PROGRESSIVE_PROMPT = `
## Progressive HTML generation
For a new substantial page, first write a SMALL complete HTML scaffold to the exact draft path. Include base design tokens, layout, and ALL planned logical sections with stable data-design-section IDs. Mark unfinished sections with data-design-pending and body with data-design-build="building". Keep the document closed after every successful file edit.
Then replace one logical section (or a group of small sections) per edit_file call, removing that section's data-design-pending when its content and styles are ready. Prioritize navigation and meaningful first-screen content, followed by the remaining sections. Reuse shared CSS variables. The host previews each committed file mutation while you continue.
Do not generate the entire stylesheet before showing the scaffold. Do not split every text or button into a tool call. Small pages may be completed in one write. Use image placeholders with reserved dimensions while completing the layout.
Complete all required sections, add business interaction scripts, remove every data-design-pending and data-design-build attribute and temporary insertion marker before finishing. A closed scaffold is NOT a finished page. Do not abandon remaining sections after the first successful write.
Use the same agent turn and existing context for subsequent sections. Do not reread all references per section or run browser verification per section; the host validates the completed artifact once.
When modifying an existing page, preserve unrelated content, stable IDs, business scripts and existing Tweaks protocol. Keep edits focused and publish complete HTML after each change.
`

export const DESIGN_DECLARATIVE_TWEAKS_PROMPT = `
## Tweaks — declarative v2 for new HTML
Declare 4–8 meaningful parameters in ONE inert <script type="application/design-tweaks+json"> JSON block containing defaults, schema and bindings. Do NOT generate a parameter panel, generic applyTweaks, edit-mode listeners or communication code: the host supplies them and embeds a standalone runtime before validation/export.
Example:
{"defaults":{"primaryColor":"#2563eb","radius":12,"ctaText":"开始使用"},"schema":{"primaryColor":{"type":"color","label":"主色"},"radius":{"type":"number","label":"圆角","min":0,"max":32,"step":1},"ctaText":{"type":"text","label":"按钮文案","maxLength":40}},"bindings":{"primaryColor":[{"type":"css-var","name":"--primary"}],"radius":[{"type":"css-var","name":"--radius","unit":"px"}],"ctaText":[{"type":"text","selector":"[data-design-tweak='ctaText']"}]}}
Every CSS-variable binding MUST be used by actual styles, e.g. background:var(--primary), border-radius:var(--radius). Numeric units belong in bindings. Text bindings must target dedicated leaf spans (no nested icons), selected by #stable-id or [data-design-tweak='key']. Boolean values may bind visibility using {"type":"visibility","selector":"#stable-id"}. Schema types: color, number, text, boolean, select (with options).
Declare global parameters in the scaffold; introduce section parameters only with their completed section. Keep keys, types and existing defaults stable across section writes. Do not mark pending placeholders as editable text targets.
Preserve user-adjusted values and existing declaration/bindings during iteration. If the current explicit user instruction changes a previously adjusted parameter, change its default and add its key to a top-level resetOverrides array. Only list keys explicitly changed by this instruction; otherwise omit resetOverrides.
For existing legacy HTML with EDITMODE-BEGIN/END markers, preserve its v1 runtime and bindings; do not add a second v2 panel or silently migrate its logic.
`
