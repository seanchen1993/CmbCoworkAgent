import { operationDefinitions, dereference, validateRef } from "../../../tests/bot/schema-support.mjs"

const six = ["createBot", "getBot", "createBotVersion", "createGroup", "getGroup", "updateGroupMembers"]
export function applicationResponses(proof) {
  if (proof.status !== "verified" || !Array.isArray(proof.responses) || proof.responses.length !== six.length) throw Error("C1_SCHEMA_PROOF")
  const seen = new Set()
  for (const item of proof.responses) {
    if (!item || !six.includes(item.operation) || seen.has(item.operation) || !Number.isInteger(item.status) || typeof item.body !== "string") throw Error("C1_SCHEMA_PROOF")
    seen.add(item.operation)
    const bytes = Buffer.from(item.body, "base64")
    if (!bytes.length || bytes.length > 1048576 || bytes.toString("base64") !== item.body) throw Error("C1_SCHEMA_PROOF")
    const op = operationDefinitions.find(x => x.operation.operationId === item.operation)?.operation
    const response = op?.responses[String(item.status)]
    if (!response) throw Error("C1_SCHEMA_PROOF")
    const schema = dereference(response).content?.["application/json"]?.schema
    if (!schema || !validateRef(schema, JSON.parse(bytes.toString("utf8"))).valid) throw Error("C1_SCHEMA_PROOF")
  }
  return seen.size
}
