import type { FlowManager } from "../flows/manager"
import { FlowStore } from "../flows/store"
import type { ModControlStore } from "../control-store"
import { EvaluationStore } from "./store"
import { EvaluationRunner } from "./runner"

/** Production provenance is fixed here; renderer/model inputs cannot mark a mock provider real. */
export function createEvaluationRunner(flows: FlowManager, settings: ModControlStore) {
  return new EvaluationRunner({
    flows,
    history: new FlowStore(settings),
    evidence: settings,
    store: new EvaluationStore(settings),
    provider: "real"
  })
}
