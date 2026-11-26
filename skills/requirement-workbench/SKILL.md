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
   - For a linked requirement, retrieve the online requirement according to the URL guidance below.
2. Read supplementary material in the `source` folder.
3. Before drafting the PRD, call the task subagent with `subagent_type="analyst"`. Include the original requirement and the relevant background content already collected in its prompt. Ask it to analyze only the supplied content, without rereading the workspace or collecting background again, and identify missing questions, scope risks, assumptions, edge cases, and pass/fail acceptance criteria. Treat its findings as analysis, not as user-confirmed decisions.
4. Synthesize the requirement goal, user scenarios, scope, business rules, and key open questions. Clarify unresolved decisions with the user one by one. Do not invent answers or treat analyst suggestions as confirmed.
5. After the user has confirmed the requirement scope, key business rules, and outstanding questions, use the `requirement-to-prd` skill to generate the formal PRD. Follow that skill's instructions and cover target users, user stories, key flows, business rules, exceptions, permissions, notifications, success metrics, and acceptance criteria as applicable.
6. Publish only when the formal PRD is ready and the user has explicitly authorized publication.

Keep discovery and clarification conversational. Do not generate a premature formal PRD merely because the workbench request asks for one.

## Linked requirement

When the requirement source is a pasted online URL, use the built-in browser to navigate to it and retrieve all readable page content before calling the analyst. Preserve its details and structure as source material; do not summarize, paraphrase, or selectively omit content. After reading, close the built-in browser. Do not interact with the page, such as clicking, typing, or executing JavaScript. If the content cannot be read, note the missing source and continue the main task without further browser exploration.
