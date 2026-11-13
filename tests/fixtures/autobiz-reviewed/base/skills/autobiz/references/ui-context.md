# UI_CONTEXT.json Reference

`UI_CONTEXT.json` is the machine fact source for UI scope. Write it before
leaving Biz stages, and use this reference before creating or editing the file.
Do not infer UI scope from Markdown after this file exists.

## UI_CONTEXT.md Auto-Generation

When `UI_CONTEXT.json` is written or updated, a human-readable `UI_CONTEXT.md`
is automatically generated in the same directory. This Markdown file:

- When `uiRequired=true`, focuses on frontend developer concerns: pages, interactions, visual sources, and restoration paths
- When `uiRequired=false`, shows the UI decision, decision source/status, and `notApplicableReason`, and omits empty frontend tables
- Shows the relationship between capabilities, HTML resources, and restoration routes
- Renders `capabilityId` values directly; it does not invent Chinese translations for capability names
- Shows a visual source's formal Plan tasks as `T00X: task title` when `uiRefs.visualSourceRefs` binds them; before Plan exists it shows `待Plan阶段关联`
- Includes a visual tree diagram mapping tasks → HTML → paths
- Can be manually edited and synced back to JSON using `sync-from-md` command
- Serves as a quick reference for frontend teams to review UI scope and implementation strategy

**Synchronization**:
- JSON → MD: automatic (on every JSON write)
- Plan → MD: automatic (on every formal Plan write, to refresh exact task IDs and titles)
- MD → JSON: manual (using `python -X utf8 hooks/ui_context_writer.py sync-from-md --feature <feature>`)

See `docs/ui-context-md-generation.md` for detailed documentation.

## Required Root Fields

- `version`: must be `1`.
- `featureId`: current feature slug.
- `uiRequired`: boolean.
- `decisionStatus`: one of `defaulted`, `confirmed`, `locked`.
- `decisionSource`: one of `user_confirmed`, `prd_inferred`, `default_false`, `legacy_import`.
- `notApplicableReason`: required when `uiRequired=false`.
- `pages`: array.
- `interactions`: array.
- `visualSources`: array.
- `capabilities`: array.

Optional checkpoint fields:

- `confirmedAtCheckpoint`: non-empty string when known, for example `discuss_done` or `prd_done`.
- `lockedAtCheckpoint`: non-empty string when specs lock the UI decision.

## ID Formats

- Page id: `PAGE-001`, `PAGE-002`, ...
- Interaction id: `UIX-001`, `UIX-002`, ...
- Visual source id: `VIS-001`, `VIS-002`, ...
- Capability id: lowercase kebab-case, for example `order-create-ui`.

Do not create `capabilities[].specRefs` in discuss or PRD. REQ/SCN ids are
defined by specs and locked later.

## Non-UI Template

```json
{
  "version": 1,
  "featureId": "{feature}",
  "uiRequired": false,
  "decisionStatus": "defaulted",
  "decisionSource": "default_false",
  "notApplicableReason": "未确认存在 UI 范围",
  "pages": [],
  "interactions": [],
  "visualSources": [],
  "capabilities": []
}
```

When the user confirms this is a non-UI feature, set:

- `decisionStatus` to `confirmed`
- `decisionSource` to `user_confirmed`
- `confirmedAtCheckpoint` to the current done checkpoint
- `notApplicableReason` to the confirmed reason

## UI Template

```json
{
  "version": 1,
  "featureId": "{feature}",
  "uiRequired": true,
  "decisionStatus": "confirmed",
  "decisionSource": "user_confirmed",
  "confirmedAtCheckpoint": "prd_done",
  "notApplicableReason": "",
  "pages": [
    {
      "pageId": "PAGE-001",
      "name": "页面名称",
      "goal": "页面目标",
      "states": ["loading", "empty", "error", "success"]
    }
  ],
  "interactions": [
    {
      "interactionId": "UIX-001",
      "pageId": "PAGE-001",
      "summary": "用户执行的核心交互"
    }
  ],
  "visualSources": [],
  "capabilities": []
}
```

## Visual Sources

Use `visualSources[]` only for design inputs such as high-fidelity HTML,
standard HTML, design links, prototypes, images, or other visual references.
Do not paste HTML or design links into PRD text as requirements.

Allowed `type` values:

- `high_fidelity_html`
- `standard_html`
- `design_link`
- `prototype_link`
- `image`
- `other`

Allowed `route` values for visual sources:

- `absolute-html`
- `standard-html`
- `spec-driven-ui`
- `missing-html`

When the user provides a high-fidelity HTML file, archive it into the Feature
artifact directory before leaving the discussion stage. Use the writer's
`--source-file` mode; do not persist an absolute local path as the stable
source. A bundle with local assets can be archived with `--source-root`:

```bash
python -X utf8 "${pluginPath}/hooks/ui_context_writer.py" add-visual-source \
  --feature "${feature}" \
  --type high_fidelity_html \
  --source-file "<HTML_PATH>" \
  --source-root "<HTML_BUNDLE_ROOT>" \
  --route absolute-html \
  --required true
```

The writer stores the entry under `frontend-html/VIS-xxx/`, records content
and bundle SHA-256 values, and later stages must use the generated `VIS-xxx`.

High-fidelity HTML that is known but not yet provided may be recorded as a
traceable required source. Its referenced UI Task cannot pass the Code
high-fidelity gate until the file is archived. Do not silently downgrade a
required source:

```json
{
  "sourceId": "VIS-001",
  "type": "high_fidelity_html",
  "path": "frontend-html/<待提供>.html",
  "route": "absolute-html",
  "required": true
}
```

If a UI capability does not require high-fidelity input, leave its
`visualSourceRefs` empty and use `spec-driven-ui`; this is valid even when
another capability in the same Feature uses a required `VIS-xxx`.

## Capability to Visual Source Binding

`capabilities[]` owns the requirement-to-UI binding. Its optional
`visualSourceRefs` must contain only existing `VIS-xxx` IDs:

```json
{
  "capabilityId": "order-create-ui",
  "uiRequired": true,
  "pageRefs": ["PAGE-001"],
  "interactionRefs": ["UIX-001"],
  "visualSourceRefs": ["VIS-001"],
  "specRefs": [
    "specs/order-create/spec.md#REQ-001",
    "specs/order-create/spec.md#SCN-001"
  ]
}
```

An ordinary UI capability without a high-fidelity source uses
`"visualSourceRefs": []`; it must not be forced to reference a placeholder
HTML file.
