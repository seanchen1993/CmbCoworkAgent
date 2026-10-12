import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { ProcessProtocol } from "../agent/process-protocol"
import type { NativeShellPlan } from "./native-shell-contract"
import { createBotNativeCommandAdapter } from "./native-shell-command"

export const nativeProbeObservation = z
  .object({
    kind: z.literal("cmb-native-isolation-probe-v1"),
    nonce: z.string().uuid(),
    readDenied: z.boolean(),
    writeDenied: z.boolean(),
    controlDenied: z.boolean(),
    pid: z.number().int().positive().max(0x7fffffff).optional()
  })
  .strict()
export type NativeProbeObservation = z.infer<typeof nativeProbeObservation>
/** This fixed source touches only fresh probe sentinels. No model strings,
 * normal user credentials, original repository or network destination. The
 * trusted outer resource and real sandbox are mandatory before invoking it. */
export const NATIVE_ISOLATION_PROBE_SOURCE = String.raw`
const fs=require("node:fs");const net=require("node:net");
const [nonce,read,write,channel,release]=process.argv.slice(1);
let readDenied=false,writeDenied=false;
try{fs.readFileSync(read)}catch(e){readDenied=e.code==="EACCES"||e.code==="EPERM"||e.code==="ENOENT"}
try{fs.writeFileSync(write,"UNEXPECTED_PROBE_WRITE",{flag:"wx"})}catch(e){writeDenied=e.code==="EACCES"||e.code==="EPERM"||e.code==="ENOENT"}
let done=false;const socket=net.connect(channel);const timer=setTimeout(()=>finish(false),2000);
function finish(controlDenied){if(done)return;done=true;clearTimeout(timer);socket.destroy();process.stdout.write(JSON.stringify({kind:"cmb-native-isolation-probe-v1",nonce,readDenied,writeDenied,controlDenied,pid:process.pid})+"\n");if(process.platform==="win32"){let attempts=0;const wait=setInterval(()=>{try{const ack=JSON.parse(fs.readFileSync(release,"utf8"));if(ack.nonce===nonce){clearInterval(wait);return}}catch{}if(++attempts>=200){clearInterval(wait);process.exitCode=125}},25)}}
socket.once("connect",()=>finish(false));socket.once("error",e=>finish(["EACCES","EPERM","ENOENT"].includes(e.code)));
`
export async function nativeIsolationProbeInvocation(input: {
  plan: NativeShellPlan
  executable: string
  nonce: string
  readSentinel: string
  deniedWrite: string
  controlChannel: string
  releaseFile?: string
  assertArtifacts(signal?: AbortSignal): Promise<void>
  signal: AbortSignal
}): Promise<{ protocol: ProcessProtocol; environment: Record<string, string> }> {
  z.string().uuid().parse(input.nonce)
  const policy = JSON.parse(input.plan.policy)
  policy.sandboxCwd = pathToFileURL(input.plan.cwd).href
  const rawPolicy = JSON.stringify(policy)
  const adapter = createBotNativeCommandAdapter(
    {
      ...input.plan,
      policy: rawPolicy,
      policySha256: createHash("sha256").update(rawPolicy).digest("hex")
    },
    input.assertArtifacts
  )
  const protocol: ProcessProtocol = {
    executable: input.executable,
    args: [
      "-e",
      NATIVE_ISOLATION_PROBE_SOURCE,
      input.nonce,
      input.readSentinel,
      input.deniedWrite,
      input.controlChannel,
      ...(input.releaseFile ? [input.releaseFile] : [])
    ],
    stdin: "",
    shell: false,
    onOutput: () => {}
  }
  return adapter({
    command: "[fixed native isolation probe]",
    shell: input.executable,
    isWindows: input.plan.platform === "win32",
    cwd: input.plan.cwd,
    protocol,
    signal: input.signal
  })
}
export function readNativeIsolationProbe(
  stdout: string,
  expectedNonce: string
): NativeProbeObservation {
  if (Buffer.byteLength(stdout) > 4096) throw new Error("Native probe output exceeds bound")
  const result = nativeProbeObservation.parse(JSON.parse(stdout.trim()))
  if (result.nonce !== expectedNonce) throw new Error("Native probe identity changed")
  if (!result.readDenied || !result.writeDenied || !result.controlDenied)
    throw new Error("Native filesystem/control-channel isolation probe failed")
  return result
}
export function nativeProbeBinding(input: {
  manifestSha256: string
  policySha256: string
  rootPins: unknown
  kernelScope: unknown
  result: NativeProbeObservation
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ format: 1, ...input }))
    .digest("hex")
}
