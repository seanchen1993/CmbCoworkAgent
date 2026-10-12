import { createHash } from "node:crypto"
import type { CoworkBot } from "../../shared/bot-types"
import type { BotProjectFiles } from "./project-files"
import type { BotModelSnapshot } from "./model-config"
import { canonicalJson } from "./validation"

export const botModFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")
export const botModsConfigurationDigest = (snapshot: BotModelSnapshot) =>
  botModFingerprint({
    mods: snapshot.mods ?? null,
    models: snapshot.models,
    defaultRef: snapshot.defaultRef
  })
export const botModsSessionConfiguration = (
  snapshot: BotModelSnapshot,
  bot: CoworkBot,
  project: BotProjectFiles
) =>
  botModFingerprint({
    configuration: botModsConfigurationDigest(snapshot),
    workspace: project.identity,
    sourceWorkspace: bot.workspacePath,
    model: bot.modelRef,
    connectors: bot.connectorIds ?? []
  })
