import { lstat, rename } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { readPrivateJson, syncDirectory, writePrivateJson } from "./backup-io"
export const windowsSetupMarker = z
  .object({
    format: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().uuid(),
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.number().int().positive()
  })
  .strict()
/** The caller has already proved exact physical closure + fixed CLI terminal.
 * An interruption before rename resumes only its own validated pending marker;
 * another operation's pending file is never deleted or borrowed. */
export async function publishWindowsSetupMarker(
  directory: string,
  identity: { scope: string; nonce: string; recordSha256: string },
  assertCurrent: () => Promise<void>
): Promise<void> {
  const name = "windows-native-setup.json",
    path = join(directory, name),
    pendingName = name + ".pending",
    pending = join(directory, pendingName)
  try {
    const prior = windowsSetupMarker.parse((await readPrivateJson(directory, name, 4096)).value)
    if (
      prior.scope === identity.scope &&
      prior.nonce === identity.nonce &&
      prior.recordSha256 === identity.recordSha256
    ) {
      await assertCurrent()
      await syncDirectory(directory)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    const pin = await lstat(pending, { bigint: true }),
      value = windowsSetupMarker.parse((await readPrivateJson(directory, pendingName, 4096)).value)
    if (
      value.scope !== identity.scope ||
      value.nonce !== identity.nonce ||
      value.recordSha256 !== identity.recordSha256
    )
      throw new Error("初始化标记与本次完成收据不一致")
    await assertCurrent()
    const now = await lstat(pending, { bigint: true })
    if (
      !now.isFile() ||
      now.isSymbolicLink() ||
      now.nlink !== 1n ||
      now.dev !== pin.dev ||
      now.ino !== pin.ino ||
      now.size !== pin.size ||
      now.mtimeNs !== pin.mtimeNs ||
      now.ctimeNs !== pin.ctimeNs
    )
      throw new Error("初始化标记发生变化")
    await rename(pending, path)
    await syncDirectory(directory)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await assertCurrent()
  await writePrivateJson(
    path,
    windowsSetupMarker.parse({ format: 1, ...identity, completedAt: Date.now() })
  )
}
