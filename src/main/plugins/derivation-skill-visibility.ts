import {
  isSkillVisibleForProjectMode as visible,
  type SkillPluginVisibilityMetadata,
  type ProjectModeSkillScope
} from "../../shared/skill-visibility"
import { derivationVisibility } from "./derivation-scope"

/** Main-process admission also covers Claw projections that omit display metadata. */
export function isSkillVisibleForProjectMode(
  source: SkillPluginVisibilityMetadata,
  scope: ProjectModeSkillScope
): boolean {
  return visible({ ...source, ...derivationVisibility(source.pluginId ?? "") }, scope)
}
