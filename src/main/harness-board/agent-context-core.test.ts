import { describe, expect, it } from "vitest"
import type {
  HarnessAgentmdLoadStatusItem,
  HarnessDeployUnitMapping,
  HarnessProjectMetadata
} from "../../shared/harness-board-types"
import {
  assembleHarnessFeatureAgentContext,
  harnessContextHookFields,
  isHarnessSessionContextOk,
  normalizeHarnessAgentConfig,
  normalizeHarnessRequestUserInputConfig,
  parseInspectCommand,
  redactHarnessText,
  redactHarnessValue,
  replaceHarnessConfigPlaceholders,
  resolveHarnessRequestUserInputConfig
} from "./agent-context-core"

const identity = {
  pluginOutputDir: "/plugin/output",
  systemId: "system-1",
  pluginRoot: "/plugin/root",
  pluginId: "plugin-1",
  pluginName: "Harness plugin",
  pluginWorkspace: "/workspace",
  featureId: "feature-1",
  harnessProjectId: "project-1",
  harnessAdapterName: "Adapter",
  harnessAdapterVersion: "1.0",
  projectCode: "code-1",
  projectDir: "project-dir"
}
const mappings: HarnessDeployUnitMapping[] = [
  { deployUnitIdMapping: "backend-map", deployUnitId: "backend", localRepoPath: "/repos/backend" },
  {
    deployUnitIdMapping: "frontend-map",
    deployUnitId: "frontend",
    localRepoPath: "/repos/frontend"
  }
]
const loadStatus: HarnessAgentmdLoadStatusItem[] = [
  {
    deployUnitId: "backend",
    path: "/repos/backend/AGENTS.md",
    loaded: false,
    source: "plugin",
    message: "missing"
  }
]
const snapshotPolicy = {
  allowAutoResolution: true,
  defaultTimeoutMs: 60_000,
  autoResolutionType: "select_first" as const
}
const pluginPolicy = {
  allowAutoResolution: true,
  defaultTimeoutMs: 90_000,
  autoResolutionType: "user_message" as const,
  userMessage: "Continue with the supplied requirements."
}
const deniedPolicy = { allowAutoResolution: false, autoResolutionType: "select_first" }
const project: HarnessProjectMetadata = {
  projectId: "project-1",
  name: "Project",
  description: "Description",
  projectCode: "project-code",
  projectFromLean: false,
  projectDir: "project-dir",
  systemId: "system-1",
  systemName: "System",
  workspacePath: "/workspace with spaces",
  "harness-adapter": { id: "plugin-1", name: "Adapter", version: "1.0", type: "plugin" },
  lifecycle: { status: "active", createAt: "2026-10-05T00:00:00.000Z" }
}

describe("shared Harness feature context assembly", () => {
  it("retains static prompt, framework AGENTS roots, identity, and the frozen session policy", () => {
    expect(
      assembleHarnessFeatureAgentContext({
        identity,
        staticPrompt: "Static project instructions",
        mappings,
        additionalRootsPrompt: "Read AGENTS.md in both repositories.",
        requestUserInputConfig: snapshotPolicy
      })
    ).toEqual({
      ...identity,
      systemPromptInject: "Static project instructions\n\nRead AGENTS.md in both repositories.",
      enableAgentsPrompt: true,
      agentConfig: { toolConfig: { requestUserInput: snapshotPolicy } },
      additionalAgentsWorkspacePaths: ["/repos/backend", "/repos/frontend"],
      additionalAgentsWorkspaceMappings: mappings
    })
  })

  it("uses complete plugin AGENTS while preserving static instructions and plugin agent settings", () => {
    const context = assembleHarnessFeatureAgentContext({
      identity,
      staticPrompt: "Static project instructions",
      mappings,
      additionalRootsPrompt: "Framework roots",
      session: {
        prompt: "  Plugin AGENTS.md instructions\n",
        agentmdLoadStatus: loadStatus,
        agentConfig: {
          agentMode: "agent_team",
          subagentConfig: {
            disabledBuiltinSubagents: ["research"],
            customSubagentFiles: ["/agents/check.md"]
          },
          toolConfig: { requestUserInput: pluginPolicy }
        }
      },
      requestUserInputConfig: snapshotPolicy
    })

    expect(context).toMatchObject({
      ...identity,
      systemPromptInject: "Static project instructions",
      enableAgentsPrompt: false,
      harnessAgentsPrompt: "Plugin AGENTS.md instructions",
      agentmdLoadStatus: loadStatus,
      agentConfig: {
        agentMode: "agent_team",
        subagentConfig: {
          disabledBuiltinSubagents: ["research"],
          customSubagentFiles: ["/agents/check.md"]
        },
        toolConfig: { requestUserInput: snapshotPolicy }
      }
    })
    expect(context).not.toHaveProperty("additionalAgentsWorkspacePaths")
    expect(context).not.toHaveProperty("additionalAgentsWorkspaceMappings")
  })

  it.each([undefined, "", " \n\t "])(
    "falls back to framework AGENTS for an absent or empty plugin prompt: %j",
    (prompt) => {
      const context = assembleHarnessFeatureAgentContext({
        identity,
        mappings,
        additionalRootsPrompt: "Framework roots",
        session: {
          prompt,
          warning: "Plugin AGENTS failed; using framework AGENTS.",
          agentmdLoadStatus: loadStatus
        }
      })

      expect(context).toMatchObject({
        systemPromptInject: "Framework roots",
        enableAgentsPrompt: true,
        additionalAgentsWorkspaceMappings: mappings,
        additionalAgentsWorkspacePaths: ["/repos/backend", "/repos/frontend"],
        sessionContextInjectWarning: "Plugin AGENTS failed; using framework AGENTS.",
        agentmdLoadStatus: loadStatus,
        agentConfig: { toolConfig: { requestUserInput: deniedPolicy } }
      })
      expect(context).not.toHaveProperty("harnessAgentsPrompt")
    }
  )

  it("resolves creation policy from the plugin only when explicitly requested", () => {
    const input = {
      identity,
      mappings: [],
      session: { agentConfig: { toolConfig: { requestUserInput: pluginPolicy } } },
      requestUserInputConfig: snapshotPolicy
    }
    expect(
      assembleHarnessFeatureAgentContext({ ...input, requestUserInputConfigSource: "plugin" })
        .agentConfig?.toolConfig?.requestUserInput
    ).toEqual(pluginPolicy)
    expect(
      assembleHarnessFeatureAgentContext({
        ...input,
        requestUserInputConfigSource: "session_snapshot"
      }).agentConfig?.toolConfig?.requestUserInput
    ).toEqual(snapshotPolicy)
    expect(
      assembleHarnessFeatureAgentContext({ ...input, requestUserInputConfig: undefined })
        .agentConfig?.toolConfig?.requestUserInput
    ).toEqual(deniedPolicy)
    expect(
      assembleHarnessFeatureAgentContext({
        ...input,
        session: undefined,
        requestUserInputConfigSource: "plugin"
      }).agentConfig?.toolConfig?.requestUserInput
    ).toEqual(deniedPolicy)
  })

  it("passes only runtime identity to hooks, excluding prompts, settings and grants", () => {
    const context = {
      ...identity,
      systemPromptInject: "Private instructions",
      harnessAgentsPrompt: "Private AGENTS",
      agentConfig: { toolConfig: { requestUserInput: pluginPolicy } },
      sessionContextInjectWarning: "Private failure detail",
      additionalAgentsWorkspacePaths: ["/extra"],
      agentmdLoadStatus: loadStatus,
      grants: ["external-action"]
    }
    expect(harnessContextHookFields(context)).toEqual(identity)
    expect(Object.values(harnessContextHookFields())).toEqual(
      Object.values(identity).map(() => undefined)
    )
  })

  it("accepts only an explicit boolean success from session-context adapters", () => {
    expect(isHarnessSessionContextOk(true)).toBe(true)
    for (const value of [false, "true", 1, {}, [], undefined, null])
      expect(isHarnessSessionContextOk(value)).toBe(false)
  })
})

describe("Harness agent and question policy normalization", () => {
  it("defaults absent or untrusted policies to manual answers", () => {
    for (const value of [
      undefined,
      null,
      [],
      "enabled",
      { allowAutoResolution: "true" },
      {
        allowAutoResolution: false,
        defaultTimeoutMs: 60_000,
        autoResolutionType: "user_message",
        userMessage: "unsafe override"
      }
    ])
      expect(resolveHarnessRequestUserInputConfig(value)).toEqual(deniedPolicy)
    expect(normalizeHarnessRequestUserInputConfig(null)).toBeUndefined()
  })

  it("keeps valid timeout boundaries and removes invalid timeout values", () => {
    for (const defaultTimeoutMs of [30_000, 240_000])
      expect(
        resolveHarnessRequestUserInputConfig({ ...snapshotPolicy, defaultTimeoutMs })
          .defaultTimeoutMs
      ).toBe(defaultTimeoutMs)
    for (const defaultTimeoutMs of [29_999, 240_001, 30_000.5, "60000", NaN, Infinity])
      expect(
        resolveHarnessRequestUserInputConfig({ ...snapshotPolicy, defaultTimeoutMs })
      ).not.toHaveProperty("defaultTimeoutMs")
  })

  it("normalizes custom timeout messages and requires a nonempty message for that policy", () => {
    expect(
      resolveHarnessRequestUserInputConfig({
        ...pluginPolicy,
        userMessage: `  ${"x".repeat(1_001)}  `
      })
    ).toEqual({ ...pluginPolicy, userMessage: "x".repeat(1_000) })
    for (const userMessage of [undefined, 1, "  "])
      expect(resolveHarnessRequestUserInputConfig({ ...pluginPolicy, userMessage })).toEqual({
        allowAutoResolution: true,
        defaultTimeoutMs: 90_000,
        autoResolutionType: "select_first"
      })
  })

  it("normalizes supported runtime modes and subagent lists while discarding unknown fields", () => {
    expect(
      normalizeHarnessAgentConfig({
        agentMode: "multi",
        subagentConfig: {
          disabledBuiltinSubagents: [" research ", "research", "", 1],
          customSubagentFiles: [" /agents/review.md ", "/agents/review.md"]
        },
        toolConfig: { requestUserInput: snapshotPolicy, unknownTool: true },
        unknownField: "unused"
      })
    ).toEqual({
      agentMode: "multi",
      subagentConfig: {
        disabledBuiltinSubagents: ["research"],
        customSubagentFiles: ["/agents/review.md"]
      },
      toolConfig: { requestUserInput: snapshotPolicy }
    })
    for (const agentMode of ["solo", "multi", "agent_team", "workflow"])
      expect(normalizeHarnessAgentConfig({ agentMode })).toEqual({ agentMode })
    expect(normalizeHarnessAgentConfig({ agentMode: "unsupported" })).toBeUndefined()
    expect(normalizeHarnessAgentConfig([])).toBeUndefined()
  })
})

describe("Harness adapter command parsing and credential redaction", () => {
  it("substitutes after tokenization so quoted secrets and JSON remain single arguments", () => {
    const secret = 'secret words"quote\\path'
    const selectedDeployUnitsJson = JSON.stringify([{ localRepoPath: "/repos/user's repo" }])
    const invocation = parseInspectCommand(
      "\"${pluginPath}/bin/inspect\" --token \"${leanToken}\" --feature '${feature}' --project ${project} --selected-deployUnit '${selectedDeployUnits}' ${projectDirs...}",
      project,
      "sessionContext",
      "/plugin with spaces",
      {
        leanToken: secret,
        feature: "Feature with spaces",
        selectedDeployUnitsJson,
        projectDirs: ["/repo one", "/repo two"]
      }
    )

    expect(invocation.executable).toBe("/plugin with spaces/bin/inspect")
    expect(invocation.args).toEqual([
      "--token",
      secret,
      "--feature",
      "Feature with spaces",
      "--project",
      "project-dir",
      "--selected-deployUnit",
      selectedDeployUnitsJson,
      "/repo one",
      "/repo two"
    ])
    expect(invocation.sensitiveValues).toEqual([secret])
    expect(Object.keys(invocation)).toEqual(["executable", "args"])
  })

  it("keeps escaped whitespace, quotes, backslashes and inline secret arguments intact", () => {
    const secret = 'quoted"secret\\value'
    const invocation = parseInspectCommand(
      'inspect --label "double\\"quote" --path \'C:\\repo\\safe\' --note plain\\ text --token="${leanToken}"',
      project,
      "run",
      "/plugin",
      { leanToken: secret }
    )

    expect(invocation.args).toEqual([
      "--label",
      'double"quote',
      "--path",
      "C:\\repo\\safe",
      "--note",
      "plain text",
      `--token=${secret}`
    ])
    expect(redactHarnessText(invocation.args.join(" "), invocation)).toContain(
      "--token=[已隐藏凭据]"
    )
  })

  it("omits missing optional flags without removing surrounding arguments", () => {
    const invocation = parseInspectCommand(
      "inspect before --workflow-template \"${workflowTemplate}\" --workflow-nodes=${workflowNodes} --selected-deployUnit '${selectedDeployUnits}' after",
      project,
      "dynamicWorkflow",
      "/plugin"
    )
    expect(invocation.args).toEqual(["before", "after"])
    expect(
      parseInspectCommand(
        'inspect --workflow-template="${workflowTemplate}"',
        project,
        "dynamicWorkflow",
        "/plugin",
        { workflowTemplate: "workflow with spaces" }
      ).args
    ).toEqual(["--workflow-template=workflow with spaces"])
  })

  it("supports project-directory fallback and explicitly preserved missing placeholders", () => {
    const fallback = { ...project, projectDir: " " }
    expect(
      replaceHarnessConfigPlaceholders(
        "${project}/${projectDir}/${projectCode}/${mode}/${sessionWorkspacePath}/${leanToken}",
        fallback,
        "run",
        "/plugin",
        { sessionWorkspacePath: "/run workspace" }
      )
    ).toBe("project-code/project-code/project-code/run//run workspace/")
    expect(
      replaceHarnessConfigPlaceholders(
        "${feature}|${leanToken}|${unknown}",
        project,
        "run",
        "/plugin",
        { preserveMissingPlaceholders: true }
      )
    ).toBe("${feature}|${leanToken}|${unknown}")
  })

  it("fails before invocation for empty commands and unterminated quotes", () => {
    expect(() => parseInspectCommand("  ", project, "run", "/plugin")).toThrow("command is empty")
    expect(() =>
      parseInspectCommand('inspect --token "${leanToken}', project, "run", "/plugin", {
        leanToken: "secret"
      })
    ).toThrow("quote is not closed")
  })

  it("redacts raw and JSON-escaped secrets from nested values and object keys", () => {
    const secret = 'secret "quoted"\\path\nline'
    const invocation = parseInspectCommand(
      'inspect --token="${leanToken}"',
      project,
      "run",
      "/plugin",
      { leanToken: secret }
    )
    const encoded = JSON.stringify(secret).slice(1, -1)
    const value = {
      [secret]: {
        prompt: `Use ${secret}`,
        args: [`--token=${secret}`, encoded],
        status: true,
        count: 2,
        empty: null
      }
    }
    const clean = redactHarnessValue(value, invocation)

    expect(clean).toEqual({
      "[已隐藏凭据]": {
        prompt: "Use [已隐藏凭据]",
        args: ["--token=[已隐藏凭据]", "[已隐藏凭据]"],
        status: true,
        count: 2,
        empty: null
      }
    })
    expect(JSON.stringify(clean)).not.toContain(encoded)
    expect(redactHarnessText(`stderr ${secret}; JSON ${encoded}`, invocation)).toBe(
      "stderr [已隐藏凭据]; JSON [已隐藏凭据]"
    )
    expect(value[secret].prompt).toBe(`Use ${secret}`)
  })

  it("fails closed on excessive nesting and treats empty credential values as absent", () => {
    let value: unknown = "safe"
    for (let index = 0; index < 33; index += 1) value = [value]
    expect(() => redactHarnessValue(value, { sensitiveValues: ["secret"] })).toThrow(
      "项目上下文嵌套过深"
    )
    expect(redactHarnessText("safe", { sensitiveValues: [""] })).toBe("safe")
  })
})
