import { createHarnessProject, createHarnessFeature, updateHarnessProjectMetadata } from "./service"
import { reportProjectSnapshotNow } from "../services/harness-status-reporter"
import type {
  HarnessProjectCreateInput,
  HarnessProjectMetadataUpdateInput,
  HarnessFeatureCreateInput
} from "../../shared/harness-board-types"

function report(projectId: string): void {
  void reportProjectSnapshotNow(projectId)
}

export async function createProject(input: HarnessProjectCreateInput) {
  const project = await createHarnessProject(input)
  report(project.projectId)
  return project
}

export async function updateProject(projectId: string, input: HarnessProjectMetadataUpdateInput) {
  const project = await updateHarnessProjectMetadata(projectId, input)
  report(projectId)
  return project
}

export async function createFeature(input: HarnessFeatureCreateInput) {
  const result = await createHarnessFeature(input)
  report(result.projectId)
  return result
}
