import { spawn } from "node:child_process"

/** Reused by model configuration and Bot credentials. Values travel over stdin, never argv. */
export async function protectWindows(data: Buffer, decrypt: boolean): Promise<Buffer> {
  const method = decrypt ? "Unprotect" : "Protect"
  const script = `Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Windows 凭据保护超时"))
    }, 15_000)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.resume() // Never include credential helper output in UI or logs.
    child.on("error", () => {
      clearTimeout(timer)
      reject(new Error("Windows 凭据保护进程无法启动"))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 || size > 2 * 1024 * 1024) reject(new Error("Windows 凭据保护失败"))
      else {
        const encoded = Buffer.concat(chunks).toString("utf8").trim(),
          result = Buffer.from(encoded, "base64")
        if (!encoded || result.toString("base64") !== encoded)
          reject(new Error("Windows 凭据保护返回无效内容"))
        else resolve(result)
      }
    })
    child.stdin.on("error", () => {})
    child.stdin.end(data.toString("base64"))
  })
}
