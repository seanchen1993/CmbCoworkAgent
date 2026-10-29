import type { ProjectDraft } from "./project-authoring-session"
import type { FunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { projectAuthoringSkillDiagnostics } from "./project-authoring-skill-metadata"

export const PROJECT_AUTHORING_READ_LIMIT = 24000
export const PROJECT_AUTHORING_FILE_PAGE = 8000

/** Bounded views keep native lifecycle events intact; no source bytes are silently truncated. */
export function projectAuthoringReadView(
  draft: ProjectDraft,
  trial: unknown,
  assetPath?: string,
  cursor = 0
) {
  const identity = {
    id: draft.id,
    name: draft.name,
    revision: draft.revision,
    sourceDigest: draft.source.digest
  }
  const preparation = draft.development?.diagnostics.includes(
    "PROJECT_AUTHORING_SKILL_METADATA_INVALID"
  )
    ? {
        candidateRevision: draft.revision,
        candidateDigest: draft.source.digest,
        candidatePrepared: false as const,
        previousPreparation: {
          revision: draft.development.currentRevision,
          digest: draft.development.currentDigest,
          activeRuns: draft.development.activeRuns,
          preserved: true as const
        },
        diagnostics: projectAuthoringSkillDiagnostics(draft.source)
      }
    : undefined
  const nativeSource = draft.source.files.some((file) => file.path === "composition/source.json")
  const authoring = nativeSource
    ? {
        protocol: "devclaw.native-composition/v1",
        sourcePath: "composition/source.json",
        stateOwner: "host",
        nextStep: { action: "project_read", id: draft.id, assetPath: "composition/source.json" },
        dependencies: { action: "catalog", catalogSection: "project-dependencies" },
        edit: {
          action: "project_patch",
          id: draft.id,
          revision: draft.revision,
          sourceDigest: draft.source.digest,
          sourcePatchTarget: "composition/source.json",
          sourcePatchOperations: ["add", "replace", "remove", "test"],
          files: "Only changed Skill/resource text; declare new resource paths in the same patch."
        },
        skillMetadata: {
          scope: "new-creator-compile-doctor-and-preparation",
          source: "The source.modules[i].skill author file, not generated skills/native-*.",
          requiredFrontmatter: ["name", "description"],
          syntax:
            "Both YAML fields must be nonempty strings. Describe the real business purpose; do not invent a description or rename existing Skill identities merely to match directories.",
          example:
            "---\nname: example-stage\ndescription: Explain this stage's actual business purpose.\n---\n\nActual stage instructions.\n",
          compatibility:
            "Existing Host fixed-path execution and retained package verification keep their existing compatibility rules."
        },
        configuration: {
          declaration: {
            path: "/configuration/userConfig",
            requiredFieldProperties: ["type", "title", "description"],
            numericBounds: ["min", "max"],
            syntax:
              "Use FunctionUserConfig field declarations here. JSON Schema keywords such as minimum/maximum belong to artifact json-schema checks, not userConfig fields.",
            example: {
              sampleLimit: {
                type: "number",
                title: "Execution limit",
                description: "An example public numeric setting; use a business-specific name.",
                required: true,
                min: 1,
                max: 100,
                default: 10
              }
            } satisfies FunctionUserConfig
          },
          constants: "check.config is package-authored action configuration, not saved userConfig.",
          checkedValues:
            "An action check may select configurationKeys from declared public userConfig. Host supplies their actual resolved values in input.configuration and includes them in input freshness. Sensitive, file and directory fields cannot be selected.",
          execution:
            "A workflow receives no implicit configuration. Host publishes the current checks' selected keys as Required stage configuration task data; the Skill passes those values as workflow arguments. The check independently compares them with Host input.configuration. No knowledge-provider rewrite is required. Do not trust a report or model to define the expected inputs."
        },
        preserve:
          "Use sourcePatch to change only the needed JSON fields without transcribing the whole composition. project_patch retains every omitted file. Read only source and the resources being changed; generated runtime/action-lock/native skills are not edit sources. Do not re-modularize a native composition through inspect_raw or a legacy adapter."
      }
    : undefined
  if (assetPath !== undefined) {
    const file = draft.source.files.find((item) => item.path === assetPath)
    if (!file) throw Error("PROJECT_DRAFT_FILE_MISSING")
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > file.text.length)
      throw Error("PROJECT_DRAFT_FILE_CURSOR_INVALID")
    const end = Math.min(file.text.length, cursor + PROJECT_AUTHORING_FILE_PAGE)
    return {
      ...identity,
      readMode: "file-page",
      file: {
        path: file.path,
        text: file.text.slice(cursor, end),
        cursor,
        totalCharacters: file.text.length
      },
      ...(end < file.text.length ? { nextCursor: end } : {}),
      saved: false
    }
  }
  if (cursor !== 0) throw Error("PROJECT_DRAFT_FILE_PATH_REQUIRED")
  const full = {
    ...draft,
    ...(authoring ? { authoring } : {}),
    ...(preparation ? { preparation } : {}),
    ...(trial ? { trial } : {})
  }
  if (JSON.stringify(full).length <= PROJECT_AUTHORING_READ_LIMIT) return full
  return {
    ...identity,
    readMode: "file-index",
    source: { digest: draft.source.digest },
    ...(authoring ? { authoring } : {}),
    ...(preparation ? { preparation } : {}),
    fileIndex: draft.source.files.map((file) => ({
      path: file.path,
      characters: file.text.length
    })),
    hint: "项目较大。按 fileIndex 使用 project_read(id,assetPath,cursor) 读取所需文件，依 nextCursor 拼接完整文本。原生组合用 project_patch 的 sourcePatch 仅修改 composition/source.json 所需字段，与 files 一次提交资源声明及新增文件，无需转写整份声明。其它文件通过 files 仅提交新增或修改项，原文件自动保留；不要把文件索引当完整源码保存。修改后用返回的新 revision 编译、检查并重新请求试用。"
  }
}
