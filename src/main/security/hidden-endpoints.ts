import { createDecipheriv } from "node:crypto"

// This hides managed endpoint literals from source control and bundled output.
// The key is intentionally separate from the bundled model credential key.
// Because the client decrypts locally, this is obfuscation rather than a security boundary.
const ENDPOINT_KEY_PARTS = [
  "dd5e927fe1203c76",
  "f69d63ea42e9bc56",
  "ec41008cb673d2f2",
  "98c4d82fb4405a0d"
] as const

type HiddenEndpoint = {
  iv: string
  authTag: string
  ciphertext: string
}

const HIDDEN_ENDPOINTS = {
  modelMinimax: {
    iv: "9KS6znKNfnIKfyG1",
    authTag: "BTrCW47oV0ah8yLg/GgNtQ==",
    ciphertext:
      "hMJ892hU9LKwiODHimT8BXBoGQvwVSjjJGiYYMH8uAdEuYibtEK+obXlWQlMF053sY9YTMM+cKS7NoW8rw=="
  },
  modelDeepseek: {
    iv: "nYIs3NhtEb5dXnZb",
    authTag: "iB2za+XswdGnXOo61RVcJA==",
    ciphertext:
      "wbTA5/BywlK7gkVg8oIaEpvofaPdhjfBSWuj6ToM7ATT99zxkVbs+MKRabqpUiMq61jkNgN5g1s3INAGixmaEmC1zghWKoE="
  },
  taskCards: {
    iv: "e+/Gu3Ki68YDjJri",
    authTag: "dPOETY96WtQ1IomO1RsQHQ==",
    ciphertext:
      "yKBz58QKOOz87zynvcu9o6u7PdaMue4YYiYMYL0EjmPwRQzJjHNqFAdFyxKIlBPJ8DEEHoOlyCYhxM/R6mYOnCzkND+Crjjk3oBb"
  },
  skillEvalDoc: {
    iv: "pA7LMD7Sowi9K+Yt",
    authTag: "iQCUoW5jF4oOBuLpyDDSdQ==",
    ciphertext: "ibl9zQNRBYodBHVjNLVR571ipRJp3AxjeGEFLz444ukECv7k+GrL"
  },
  knowledgeGuide: {
    iv: "eGSGSrin76Pjhm9h",
    authTag: "BTfmPvrXtwcnoz4BDojvSw==",
    ciphertext: "HAXt7sI3uHSPRmHLYz148QjhaI1NdH7mX2fAlf9GcE5fassbbNk="
  }
} satisfies Record<string, HiddenEndpoint>

export type HiddenEndpointId = keyof typeof HIDDEN_ENDPOINTS

const endpointCache = new Map<HiddenEndpointId, string>()

function decryptEndpoint(payload: HiddenEndpoint): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(ENDPOINT_KEY_PARTS.join(""), "hex"),
    Buffer.from(payload.iv, "base64")
  )
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"))
  const value = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ])
    .toString("utf8")
    .trim()

  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("隐藏端点必须使用 http/https")
  }
  return value
}

export function getHiddenEndpoint(id: HiddenEndpointId): string {
  const cached = endpointCache.get(id)
  if (cached) return cached
  const value = decryptEndpoint(HIDDEN_ENDPOINTS[id])
  endpointCache.set(id, value)
  return value
}
