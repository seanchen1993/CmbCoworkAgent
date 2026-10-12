import { expect, test } from "vitest"
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const script = pathToFileURL(resolve("scripts/bot-native-sandbox/verify-linux-abi.mjs")).href
async function inspect(value: string): Promise<{
  result?: { needed: string[]; versions: string[] }
  error?: string
}> {
  const code = `
const {inspectPrivateHeaders}=await import(${JSON.stringify(script)});
try { console.log(JSON.stringify({result:inspectPrivateHeaders(${JSON.stringify(value)})})); }
catch(error) { console.log(JSON.stringify({error:error.message})); }
`
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", code], {
    timeout: 10_000,
    maxBuffer: 65536
  })
  return JSON.parse(stdout)
}
const headers = (requirements: string): string => `
provider: file format elf64-x86-64
Dynamic Section:
  NEEDED libc.so.6
  NEEDED libssl.so.1.1
Version References:
 required from libc.so.6:
   0x06969188 0x00 02 ${requirements}
`
test("accepts the actual GNU/LLVM version-reference shape at the 2.28 ceiling", async () => {
  const result = await inspect(
    headers("GLIBC_2.2.5 GLIBC_2.28 GLIBCXX_3.4.25 CXXABI_1.3.11 GCC_4.8.0 OPENSSL_1_1_1")
  )
  expect(result.error).toBeUndefined()
  expect(result.result?.needed).toEqual(["libc.so.6", "libssl.so.1.1"])
  expect(result.result?.versions).toContain("GLIBC_2.28")
})
test.each([
  "GLIBC_2.29",
  "GLIBC_2.28.1",
  "GLIBC_2.39",
  "GLIBC_2.100",
  "GLIBC_PRIVATE",
  "GLIBC_ABI_DT_RELR",
  "GLIBCXX_3.4.26",
  "GLIBCXX_3.4.100",
  "CXXABI_1.3.12",
  "GCC_12.0.0",
  "OPENSSL_3.0.0"
])("rejects a real unsupported ABI tag %s", async (requirement) => {
  expect((await inspect(headers(requirement))).error).toMatch(/ABI|requires|unsupported/)
})
test("checks requirements rather than confusing a DSO's version definitions with dependencies", async () => {
  const result = await inspect(
    `provider: file format elf64-x86-64\nVersion definitions:\n  GLIBC_2.39\nVersion References:\n required from libc.so.6:\n  0x0 0x00 02 GLIBC_2.28\n`
  )
  expect(result.error).toBeUndefined()
  expect(result.result?.versions).toEqual(["GLIBC_2.28"])
})
test.each(["elf64-littleaarch64", "pei-x86-64", "elf32-i386"])(
  "rejects mismatched release machine %s",
  async (format) => {
    expect((await inspect(headers("GLIBC_2.28").replace("elf64-x86-64", format))).error).toMatch(
      /x64 ELF/
    )
  }
)
