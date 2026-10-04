import { daemon, docker } from "./host.mjs"

export const SERVICE_IMAGES = Object.freeze({
  es: {
    reference: "docker.elastic.co/elasticsearch/elasticsearch:8.19.22@sha256:c2a3ed5f968be6d59c960aa0c60cfdaee667b6bc8211142021a41d0e85b43237",
    digest: "sha256:c2a3ed5f968be6d59c960aa0c60cfdaee667b6bc8211142021a41d0e85b43237",
    config: "sha256:a1cc67962f24c058c854acc6aab0d0adaefefc945c0bfaaebb52aba6129de160",
    architecture: "arm64", version: "8.19.22", repository: "docker.elastic.co/elasticsearch/elasticsearch"
  },
  s3: {
    reference: "docker.io/chrislusf/seaweedfs:4.48@sha256:f1f303474940e9e088edbd2c1658f7ac38cb0dd90f91a2b0a51916d74b8575a1",
    digest: "sha256:f1f303474940e9e088edbd2c1658f7ac38cb0dd90f91a2b0a51916d74b8575a1",
    config: "sha256:8f17c8c82e037886f6aaceb3f6282a5c2a1b52bbef5339d323b0067a75bbbc79",
    architecture: "arm64", version: "4.48", repository: "chrislusf/seaweedfs"
  }
})

export async function serviceImage(state, service, { pull = false } = {}) {
  const expected = SERVICE_IMAGES[service]
  if (!expected) throw new Error("B00_SERVICE")
  await daemon(state)
  if (pull) await docker(state, ["pull", "--platform", `linux/${expected.architecture}`, expected.reference], { timeoutMs: 600000, maxOutput: 262144 })
  const data = JSON.parse(await docker(state, ["image", "inspect", expected.reference], { stdoutOnly: true }))[0]
  if (data.Id !== expected.digest || data.Descriptor?.digest !== expected.digest || !data.RepoDigests?.includes(`${expected.repository}@${expected.digest}`) || data.Architecture !== expected.architecture || data.Os !== "linux") throw new Error("B00_IMAGE_VERSION")
  return { service, image: expected.reference, id: data.Id, architecture: data.Architecture, version: expected.version }
}
