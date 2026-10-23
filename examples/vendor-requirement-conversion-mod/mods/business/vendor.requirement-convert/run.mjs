import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Deterministic acceptance runner for the independent fixture. This is not an LLM or an
// application hook. Tests execute this exact retained plugin file through a real child process.
const [stage, pluginRoot, workspace, policyTier = "enhanced"] = process.argv.slice(2)
const policy = readFileSync(join(pluginRoot, "knowledge/admission-policy.md"), "utf8")
if (!policy.includes("VENDOR_POLICY_2026_01")) throw Error("VENDOR_POLICY_REQUIRED")
if (!["standard", "enhanced"].includes(policyTier)) throw Error("VENDOR_CONFIG_REQUIRED")
const read = (name) => JSON.parse(readFileSync(join(workspace, name), "utf8"))
const write = (name, value) => writeFileSync(join(workspace, name), JSON.stringify(value))
if (stage === "convert") {
  const raw = read("raw-request.json")
  for (const key of ["vendorName", "registrationId", "source"])
    if (typeof raw[key] !== "string" || !raw[key].trim()) throw Error("VENDOR_INPUT_REQUIRED")
  const { vendorName, registrationId, source } = raw
  write("normalized-request.json", {
    schemaVersion: 1,
    vendorName,
    registrationId,
    source,
    policyTier
  })
} else if (stage === "dossier") {
  const normalized = read("normalized-request.json")
  if (normalized.schemaVersion !== 1 || normalized.policyTier !== policyTier)
    throw Error("VENDOR_NORMALIZED_INPUT_INCOMPATIBLE")
  const { vendorName, registrationId, source } = normalized
  write("dossier.json", { vendorName, registrationId, source, policyTier })
} else if (stage === "decision") {
  const dossier = read("dossier.json")
  write("vendor-report.json", {
    vendorName: dossier.vendorName,
    policyTier: dossier.policyTier,
    decision: "needs-human-review",
    qualificationStatus: "not-requested",
    sources: ["normalized-request.json", "dossier.json"]
  })
} else throw Error("VENDOR_STAGE_UNKNOWN")
process.stdout.write(JSON.stringify({ stage, knowledge: "VENDOR_POLICY_2026_01", policyTier }))
