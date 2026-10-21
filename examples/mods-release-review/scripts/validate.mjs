import fs from "node:fs"
import crypto from "node:crypto"

// An ordinary plugin-owned validator: no application-specific native implementation.
try {
  const check = process.argv[2]
  const bytes = fs.readFileSync("release-review.json")
  const artifact = JSON.parse(bytes)
  if (typeof artifact.description !== "string" || !artifact.description.trim())
    throw Error("发布说明不能为空")
  if (check === "approval" && artifact.qualityAccepted !== true) throw Error("业务质量检查尚未通过")
  if (!["metadata", "approval"].includes(check)) throw Error("未知校验")
  process.stdout.write(
    JSON.stringify({
      passed: true,
      check,
      artifactDigest: crypto.createHash("sha256").update(bytes).digest("hex")
    })
  )
} catch (error) {
  process.stderr.write(String(error.message))
  process.exitCode = 2
}
