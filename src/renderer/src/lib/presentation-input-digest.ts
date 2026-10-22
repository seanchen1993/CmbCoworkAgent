// Browser-only, synchronous SHA-256 of UTF-8 text. This is a bounded cache identity,
// never an authorization proof or a substitute for native source/scope validation.
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

export function presentationInputDigest(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const words = new Uint32Array(64)
  // Only the final one/two blocks are copied; no padded copy of the whole input.
  const remainder = bytes.length % 64
  const tail = new Uint8Array(remainder < 56 ? 64 : 128)
  tail.set(bytes.subarray(bytes.length - remainder))
  tail[remainder] = 0x80
  const tailView = new DataView(tail.buffer)
  tailView.setUint32(tail.length - 8, Math.floor(bytes.length / 0x20000000))
  tailView.setUint32(tail.length - 4, (bytes.length * 8) >>> 0)

  const compress = (block: Uint8Array, offset: number): void => {
    for (let i = 0; i < 16; i++) {
      const index = offset + i * 4
      words[i] =
        (block[index] << 24) | (block[index + 1] << 16) | (block[index + 2] << 8) | block[index + 3]
    }
    for (let i = 16; i < 64; i++) {
      const left = words[i - 15],
        right = words[i - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
      words[i] = words[i - 16] + sigma0 + words[i - 7] + sigma1
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const next = (h + sigma1 + choose + ROUND_CONSTANTS[i] + words[i]) >>> 0
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      h = g
      g = f
      f = e
      e = (d + next) >>> 0
      d = c
      c = b
      b = a
      a = (next + sigma0 + majority) >>> 0
    }
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
    state[4] += e
    state[5] += f
    state[6] += g
    state[7] += h
  }
  for (let offset = 0; offset < bytes.length - remainder; offset += 64) compress(bytes, offset)
  for (let offset = 0; offset < tail.length; offset += 64) compress(tail, offset)
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("")
}
