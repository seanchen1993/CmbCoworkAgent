import { dirname, join, resolve } from "node:path"
import { getCandidates } from "../../agent/optimizer/skill-optimizer"
import {
  getCustomSkillsDir,
  findExistingSkillById,
  invalidateEnabledSkillsCache
} from "../../storage"
import { bumpHookCatalogGlobalRevision } from "../../hook-catalog/revision"
import type { ModControlStore } from "../control-store"
import { FlowStore } from "../flows/store"
import type { EvaluationRunner } from "./runner"
import { SkillSnapshotFiles } from "./skill-files"
import { SkillEvaluationBridge } from "./skill-bridge"
import { skillPath } from "./skill-snapshots"

export function createSkillEvaluationService(
  settings: ModControlStore,
  runner: EvaluationRunner,
  notify: () => void
) {
  const root = getCustomSkillsDir()
  return new SkillEvaluationBridge({
    settings,
    runner,
    candidates: getCandidates,
    flows: new FlowStore(settings),
    files: new SkillSnapshotFiles(root, join(dirname(root), "skill-evaluation-backups"), (id) => {
      const existing = findExistingSkillById(id)
      const expected = resolve(skillPath(root, id), "SKILL.md")
      if (existing && resolve(existing.skillMdPath).toLowerCase() !== expected.toLowerCase())
        throw Error("SKILL_EVALUATION_UNSUPPORTED")
    }),
    changed: () => {
      bumpHookCatalogGlobalRevision()
      invalidateEnabledSkillsCache()
      notify()
    }
  })
}
