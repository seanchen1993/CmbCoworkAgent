---
name: requirement-workbench
description: Handle a requirement-workbench request by reading its source materials, clarifying product scope with the requirement analyst, and producing an accurate PRD only after key questions are confirmed.
---

# Requirement Workbench

Turn the requirement information in the current message and workspace into an accurate product requirement document. Use the `requirement-to-prd` skill for PRD work; this skill coordinates the requirement-workbench flow and does not replace `requirement-to-prd`.

## Workflow

1. Read the original requirement.
   - For a text requirement, use the initial description supplied in the message.
   - For an uploaded requirement, read `source-preview.md` and the available source files.
   - For a linked requirement, use the built-in browser to navigate to the primary link and read the relevant page content.
2. Read supplementary material in the `source` folder. When it contains links, use the built-in browser to summarize the relevant page content. If a supplementary link cannot be accessed, skip it and state that limitation instead of blocking the whole task.
3. Before drafting the PRD, call the task subagent with `subagent_type="analyst"`. Give it the requirement and the source content already collected, and ask for missing questions, scope risks, assumptions, edge cases, and pass/fail acceptance criteria. The subagent must not browse URLs. Treat its findings as analysis, not as user-confirmed decisions.
4. Synthesize the requirement goal, user scenarios, scope, business rules, and key open questions. Clarify unresolved decisions with the user one by one. Do not invent answers or treat analyst suggestions as confirmed.
5. After the user has confirmed the requirement scope, key business rules, and outstanding questions, use the `requirement-to-prd` skill to generate the formal PRD. Follow that skill's instructions and cover target users, user stories, key flows, business rules, exceptions, permissions, notifications, success metrics, and acceptance criteria as applicable.
6. Publish only when the formal PRD is ready and the user has explicitly authorized publication.

Keep discovery and clarification conversational. Do not generate a premature formal PRD merely because the workbench request asks for one.

## Browser research

For each supplied URL, call only `browser_navigate`, `browser_snapshot`, and `browser_close`, once each and in that order. Continue with the content returned by the snapshot; if it is insufficient, note the missing background instead of trying other browser tools or delegating more browser work.
