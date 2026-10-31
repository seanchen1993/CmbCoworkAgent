import { session, type Session } from "electron"

export const BROWSER_PROFILE_PARTITION = "persist:cmbdevclaw-browser-profile"

/** One profile for navigation, imported cookies and authenticated design capture. */
export function getBuiltinBrowserSession(): Session {
  return session.fromPartition(BROWSER_PROFILE_PARTITION)
}
