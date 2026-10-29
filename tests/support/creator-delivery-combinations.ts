import { KNOWLEDGE_MARKER } from "./project-library-packaged-journey"

export const CREATOR_DELIVERY_COMBINATIONS = ["prefix", "middle-skill", "independent"] as const
export type CreatorDeliveryCombinationId = (typeof CREATOR_DELIVERY_COMBINATIONS)[number]
export interface DeliveryCombinationStage {
  id: string
  skill: string
  title: string
  marker: string
  path: string
}
const policy = "DELIVERY_POLICY_COMPLETE: retain original evidence and require human review."
export function creatorDeliveryCombination(id: CreatorDeliveryCombinationId) {
  const definitions = {
    prefix: [
      ["convert", "convert", "Convert incoming order", "CREATOR_PREFIX_CONVERSION"],
      ["prepare", "prepare", "Prepare converted order", "CREATOR_PREPARE_CONVERTED"],
      ["review", "review", "Review converted order", "CREATOR_REVIEW_CONVERTED"]
    ],
    "middle-skill": [
      ["prepare", "prepare", "Prepare source draft", "CREATOR_MIDDLE_INPUT"],
      [
        "refine",
        "refine-v2",
        "Refine with revised middle Skill",
        "CREATOR_MIDDLE_SKILL_REVISION_2"
      ],
      ["review", "review", "Review revised middle output", "CREATOR_MIDDLE_REVIEW"]
    ],
    independent: [
      ["intake", "intake", "Assess independent service request", "CREATOR_SERVICE_INTAKE"],
      ["deliver", "deliver", "Deliver independent service receipt", "CREATOR_SERVICE_DELIVERY"]
    ]
  }
  const stages: DeliveryCombinationStage[] = definitions[id].map(
    ([stageId, skill, title, marker]) => ({
      id: stageId,
      skill,
      title,
      marker,
      path: `${stageId}.json`
    })
  )
  const configurationValue = `CONFIGURATION_${id.toUpperCase().replaceAll("-", "_")}`
  const configuration = {
    customer: {
      type: "string",
      title: "业务标识",
      description: "本项目的必填业务标识",
      required: true
    }
  }
  const output = (index: number) => ({
    combination: id,
    step: stages[index].id,
    marker: stages[index].marker,
    previous: stages.slice(0, index).map((stage) => stage.id),
    policy,
    ...(index ? { knowledge: KNOWLEDGE_MARKER } : {})
  })
  const skill = (stage: DeliveryCombinationStage) => ({
    path: `skills/${stage.skill}/SKILL.md`,
    text:
      `---\nname: ${stage.skill}\ndescription: ${stage.title}\n---\n${stage.marker}\n` +
      `Read this actual Skill and retained knowledge/policy.md. Read every preceding stage JSON. ` +
      `Write ${stage.path} using the preceding real artifacts. Keep human approval and native checks.\n`
  })
  const addedSkills = id === "prefix" ? [stages[0]] : id === "middle-skill" ? [stages[1]] : []
  const catalog = {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: `classic.delivery-${id}`,
      version: "1.0.0",
      runtime: { adapter: "host-linear-v1" },
      pluginFields: { skills: "skills", hooks: "hooks/hooks.json", userConfig: configuration },
      resources: [
        "knowledge/policy.md",
        "hooks/hooks.json",
        "tests/project-contract.json",
        ...(id === "middle-skill" ? ["skills/refine-v1/SKILL.md"] : [])
      ]
    },
    modules: stages.map((stage, index) => ({
      id: stage.id,
      title: stage.title,
      node: { id: stage.id, skill: stage.skill, order: index },
      skill: { entry: `skills/${stage.skill}/SKILL.md`, resources: [] },
      resources: [],
      dependencies: {
        required: stages.slice(0, index).map((previous) => previous.id),
        advisory: []
      },
      checks: { validators: [], guards: [] },
      host: {
        stage: {
          actionIds: [],
          artifactIds: stages.slice(0, index + 1).map((value) => value.id),
          checkIds: stages.slice(0, index + 1).map((value) => `${value.id}-schema`),
          approval: "human"
        },
        actions: [],
        artifacts: stages
          .slice(0, index + 1)
          .map((value) => ({ id: value.id, path: value.path, required: true })),
        checks: stages.slice(0, index + 1).map((value) => ({
          id: `${value.id}-schema`,
          artifactId: value.id,
          kind: "json-schema",
          sideEffect: "read",
          schema: {
            type: "object",
            properties: {
              combination: { const: id },
              step: { const: value.id },
              marker: { const: value.marker }
            },
            required: ["combination", "step", "marker", "previous"]
          }
        })),
        environment: []
      }
    }))
  }
  const addedFiles = [
    ...addedSkills.map(skill),
    {
      path: "tests/project-contract.json",
      text: JSON.stringify({
        apiVersion: "devclaw.project-contract/v1",
        cases: stages.flatMap((stage, index) => [
          { id: `${stage.id}-missing`, stageId: stage.id, files: [], expected: "failed" },
          {
            id: `${stage.id}-valid`,
            stageId: stage.id,
            files: stages
              .slice(0, index + 1)
              .map((value, offset) => ({ path: value.path, text: JSON.stringify(output(offset)) })),
            expected: "passed"
          }
        ])
      })
    }
  ]
  return {
    id,
    stages,
    catalog,
    addedFiles,
    output,
    configurationValue,
    sourceFiles: (hookUrl: string) => [
      {
        path: "plugin.json",
        text: JSON.stringify({
          name: `creator-raw-${id}`,
          version: "1.0.0",
          skills: "skills",
          hooks: "hooks/hooks.json",
          userConfig: configuration
        })
      },
      ...stages.filter((stage) => !addedSkills.includes(stage)).map(skill),
      ...(id === "middle-skill"
        ? [
            {
              path: "skills/refine-v1/SKILL.md",
              text: "---\nname: refine-v1\ndescription: Retained original middle Skill\n---\nCREATOR_MIDDLE_SKILL_REVISION_1\n"
            }
          ]
        : []),
      { path: "knowledge/policy.md", text: `${policy}\n` },
      {
        path: "hooks/hooks.json",
        text: JSON.stringify(
          ["PreSkillUse", "PostSkillUse"].map((event) => ({
            id: `retained-delivery-${event}`,
            event,
            matcher: stages.map((stage) => stage.skill).join("|"),
            type: "http",
            url: `${hookUrl}/${event}`,
            timeoutMs: 10000
          }))
        )
      }
    ]
  }
}
export type CreatorDeliveryCombination = ReturnType<typeof creatorDeliveryCombination>
