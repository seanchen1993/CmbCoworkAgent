import { UserInfoConfig } from "../../main/storage"

interface MmjTracker {
  setConfig?: (config: Record<string, string>) => void
  updateUserInfo?: (config: Record<string, string | null>) => void
  updateMMJDomClick?: (payload: { id: string; text: string }) => void
  sendLogToMMJ?: (text: string) => void
}

declare global {
  interface Window {
    mmjTrack?: MmjTracker
    mmjStart?: boolean
  }
}

let mmjLoadPromise: Promise<void> | null = null

function loadMmjFromCdn(): Promise<void> {
  if (window.mmjTrack) {
    return Promise.resolve()
  }
  if (mmjLoadPromise) {
    return mmjLoadPromise
  }

  const scriptUrl = import.meta.env.VITE_MMJ_CDN_URL?.trim()
  if (!scriptUrl) {
    console.warn("[MMJ] VITE_MMJ_CDN_URL is empty, skip MMJ initialization.")
    return Promise.resolve()
  }

  mmjLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-mmj-cdn="${scriptUrl}"]`) as HTMLScriptElement | null
    if (existing) {
      if (window.mmjTrack) resolve()
      else reject(new Error("MMJ CDN script tag exists but mmjTrack is not ready"))
      return
    }

    const script = document.createElement("script")
    script.src = scriptUrl
    script.async = true
    script.setAttribute("data-mmj-cdn", scriptUrl)
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load MMJ CDN script: ${scriptUrl}`))
    document.head.appendChild(script)
  }).catch((error) => {
    console.error("[MMJ] CDN load failed:", error)
  })

  return mmjLoadPromise
}

export function initMMJ(): void {
  void loadMmjFromCdn().then(() => {
    if (window.mmjTrack && !window.mmjStart) {
      window.mmjStart = true
      console.log("初始化MMJ")
      const ip = localStorage.getItem("localIp")
      window.mmjTrack.setConfig?.({
        env: "prodOA",
        appName: "CMBDevClaw",
        productCode: "LA64.06",
        userId: ip || "游客",
        positionId: localStorage.getItem("version") || ""
      })

      updateMMJUserInfo()
    }
  })
}

export const updateMMJUserInfo = (): void => {
  window.api.models.getUserInfo().then(user => {
    const userInfo = user || {} as UserInfoConfig
    console.log('getUserInfo():', userInfo)
    if (userInfo && (userInfo?.ystId || userInfo?.sapId)){
      if (window.mmjTrack?.updateUserInfo) {
        window.mmjTrack.updateUserInfo({
          userId: localStorage.getItem("localIp")  || "游客",
          userName: `${userInfo.ystId || userInfo.sapId} / ${userInfo.userName}`,
          org: userInfo.orgName || '',
          orgId: userInfo.originOrgId || '',
          positionId: localStorage.getItem("version") || ""
        })
      }
    }
  }).catch(e => {
    console.error('updateMMJUserInfo error:', e)
  })



}

export const insertDomLog = ({ id, text }: { id: string; text: string }): void => {
  if (window.mmjTrack?.updateMMJDomClick && id && text) {
    window.mmjTrack.updateMMJDomClick({ id, text })
  }
}

export const insertLog = (text: string): void => {
  if (window.mmjTrack?.sendLogToMMJ && text) {
    window.mmjTrack.sendLogToMMJ(text)
  }
}
