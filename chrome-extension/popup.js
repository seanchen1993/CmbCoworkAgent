/* global chrome */

const status = document.querySelector("#status")
const result = document.querySelector("#result")
const authorize = document.querySelector("#authorize")
const reconnect = document.querySelector("#reconnect")
const statusCard = document.querySelector("#status-card")
const EXPECTED_EXTENSION_ID = "lnfdbegfbhhlfimnojpalnkmhkgfahin"
const SUPPORT_CONTACT = "如有问题，请联系开发 xx。"
const ALL_SITE_ORIGINS = ["http://*/*", "https://*/*"]
const OPTIONAL_HOST_PERMISSIONS_MIN_CHROME = 102
const POPUP_LOG_PREFIX = "[CmbBrowserExtension][Popup]"
let lastPopupStatusSignature = ""

function popupLogger(method, message, details) {
  if (typeof console === "undefined") return
  const writer = console[method]
  if (typeof writer !== "function") return
  if (details === undefined) {
    writer.call(console, `${POPUP_LOG_PREFIX} ${message}`)
    return
  }
  writer.call(console, `${POPUP_LOG_PREFIX} ${message}`, details)
}

function popupInfo(message, details) {
  popupLogger("info", message, details)
}

function popupWarn(message, details) {
  popupLogger("warn", message, details)
}

function popupError(message, details) {
  popupLogger("error", message, details)
}

function summarizePopupStatus(response) {
  return {
    connected: response?.connected === true,
    nativeHostStarted: response?.nativeHostStarted === true,
    permissionGranted: response?.permissionGranted === true,
    nativeHostError:
      typeof response?.nativeHostError === "string" && response.nativeHostError
        ? response.nativeHostError
        : ""
  }
}

function logPopupStatusChange(response) {
  const summary = summarizePopupStatus(response)
  const signature = JSON.stringify(summary)
  if (signature === lastPopupStatusSignature) return
  lastPopupStatusSignature = signature
  popupInfo("popup-status changed", summary)
}

function chromeMajorVersion(userAgent = navigator.userAgent) {
  const match = /Chrome\/(\d+)/.exec(userAgent || "")
  return match ? Number.parseInt(match[1], 10) : Number.NaN
}

function supportsPopupPermissionPrompt() {
  const version = chromeMajorVersion()
  return Number.isFinite(version) && version >= OPTIONAL_HOST_PERMISSIONS_MIN_CHROME
}

function updateAuthorizeButtonLabel(label) {
  authorize.textContent = label
}

function friendlyConnectionError(error) {
  if (!error) return "桌面应用未连接"
  if (error.includes("Error when communicating with the native messaging host")) {
    return "Native Host 已找到，但启动或通信失败"
  }
  if (error.includes("Specified native messaging host not found")) {
    return "Native Host 尚未注册，请先启动桌面应用"
  }
  if (error.includes("Access to the specified native messaging host is forbidden")) {
    return "当前扩展版本未获桌面应用授权"
  }
  if (error.includes("ENOENT") || error.includes("ECONNREFUSED")) {
    return "桌面应用的 Cookie Bridge 尚未就绪"
  }
  return error
}

function friendlyConnectionHint(error) {
  if (!error) {
    return "请确认桌面应用已经启动，然后点击“重新连接”再次检查。"
  }
  if (error.includes("Error when communicating with the native messaging host")) {
    return "请确认桌面应用正在运行，并稍后点击“重新连接”重试。"
  }
  if (error.includes("Specified native messaging host not found")) {
    return "请先启动 Windows 打包版 CmbDevClaw；开发模式不会注册 Native Host。"
  }
  if (error.includes("Access to the specified native messaging host is forbidden")) {
    return "请重新安装项目提供的扩展版本。"
  }
  if (error.includes("ENOENT") || error.includes("ECONNREFUSED")) {
    return "桌面应用中的 Cookie Bridge 还未就绪，请稍后点击“重新连接”再试。"
  }
  return `请稍后重试；${SUPPORT_CONTACT}`
}

function renderState({ tone, title, detail, showAuthorize = false, showReconnect = false }) {
  statusCard.dataset.tone = tone
  status.textContent = title
  result.textContent = detail
  authorize.hidden = !showAuthorize
  reconnect.hidden = !showReconnect
}

function renderLegacyAuthorizationState() {
  popupInfo("rendering legacy authorization state", {
    chromeMajorVersion: chromeMajorVersion(),
    supportsPopupPermissionPrompt: supportsPopupPermissionPrompt()
  })
  updateAuthorizeButtonLabel("查看授权步骤")
  renderState({
    tone: "warning",
    title: "已连接，等待 Chrome 站点访问授权",
    detail: "当前 Chrome 版本不支持在扩展弹窗内直接弹出授权确认。请点击下方按钮查看手动授权步骤。",
    showAuthorize: true,
    showReconnect: false
  })
}

function renderLegacyAuthorizationGuide() {
  popupInfo("rendering legacy authorization guide")
  updateAuthorizeButtonLabel("我已完成，重新检查")
  renderState({
    tone: "warning",
    title: "请在扩展详情页授予站点访问",
    detail:
      "1. 右键工具栏中的扩展图标，打开“管理扩展程序”；2. 找到“站点访问”；3. 选择“在所有网站上”；4. 回到这里等待状态自动刷新，或再次点击按钮重新检查。",
    showAuthorize: true,
    showReconnect: false
  })
}

function requestStatus() {
  if (chrome.runtime.id !== EXPECTED_EXTENSION_ID) {
    popupWarn("unexpected extension id", {
      actualExtensionId: chrome.runtime.id,
      expectedExtensionId: EXPECTED_EXTENSION_ID
    })
    renderState({
      tone: "error",
      title: "当前扩展版本未获桌面应用授权",
      detail: "请重新安装项目提供的扩展版本。",
      showAuthorize: false,
      showReconnect: false
    })
    return
  }
  chrome.runtime.sendMessage({ type: "popup-status" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      popupWarn("popup-status request failed", {
        error: chrome.runtime.lastError?.message || "missing response"
      })
      renderState({
        tone: "error",
        title: "扩展后台服务暂不可用",
        detail: friendlyConnectionHint(chrome.runtime.lastError?.message),
        showAuthorize: false,
        showReconnect: true
      })
      return
    }

    logPopupStatusChange(response)

    if (!response.connected) {
      updateAuthorizeButtonLabel("授权读取网站 Cookie")
      renderState({
        tone: "error",
        title: friendlyConnectionError(response.nativeHostError),
        detail: response.nativeHostError
          ? friendlyConnectionHint(response.nativeHostError)
          : "正在等待桌面应用响应，请稍后点击“重新连接”再试。",
        showAuthorize: false,
        showReconnect: true
      })
    } else {
      const popupPermissionPromptSupported = supportsPopupPermissionPrompt()
      if (!response.permissionGranted && !popupPermissionPromptSupported) {
        renderLegacyAuthorizationState()
        return
      }
      updateAuthorizeButtonLabel("授权读取网站 Cookie")
      renderState({
        tone: response.permissionGranted ? "success" : "warning",
        title: response.permissionGranted ? "已连接并完成授权" : "已连接，等待 Cookie 授权",
        detail: response.permissionGranted
          ? "现在可以回到 CmbDevClaw 继续导入，扩展会在后台保持待命。"
          : "点击下方按钮后，Chrome 会弹出权限确认；允许后即可回到桌面应用继续导入。",
        showAuthorize: !response.permissionGranted,
        showReconnect: false
      })
    }
  })
}

authorize.addEventListener("click", () => {
  popupInfo("authorize button clicked", {
    chromeMajorVersion: chromeMajorVersion(),
    supportsPopupPermissionPrompt: supportsPopupPermissionPrompt(),
    currentButtonLabel: authorize.textContent
  })
  if (!supportsPopupPermissionPrompt()) {
    if (authorize.textContent === "我已完成，重新检查") {
      popupInfo("manual authorization flow recheck requested")
      requestStatus()
      return
    }
    renderLegacyAuthorizationGuide()
    return
  }
  authorize.disabled = true
  renderState({
    tone: "loading",
    title: "等待 Chrome 权限确认",
    detail: "请在浏览器弹窗中允许读取当前网站数据，完成后会自动刷新状态。",
    showAuthorize: true,
    showReconnect: false
  })
  chrome.permissions.request({ origins: ALL_SITE_ORIGINS }, (granted) => {
    const permissionError = chrome.runtime.lastError?.message || ""
    if (permissionError) {
      popupWarn("runtime permission request returned an error", { error: permissionError })
    } else {
      popupInfo("runtime permission request completed", { granted: granted === true })
    }
    if (chrome.runtime.lastError || !granted) {
      renderState({
        tone: "warning",
        title: "未完成授权",
        detail: chrome.runtime.lastError?.message
          ? "Chrome 未完成权限授予，请重试。"
          : "你可以再次点击授权按钮重试，完成后回到桌面应用继续导入。",
        showAuthorize: true,
        showReconnect: false
      })
    }
    authorize.disabled = false
    requestStatus()
  })
})

reconnect.addEventListener("click", () => {
  popupInfo("reconnect button clicked", {
    currentStatus: status.textContent,
    currentDetail: result.textContent
  })
  reconnect.disabled = true
  renderState({
    tone: "loading",
    title: "正在重新连接桌面应用",
    detail: "请稍候，扩展正在重新检查 Native Host 与桌面应用状态。",
    showAuthorize: false,
    showReconnect: true
  })
  chrome.runtime.sendMessage({ type: "reconnect-native" }, () => {
    if (chrome.runtime.lastError) {
      popupError("reconnect-native request failed", { error: chrome.runtime.lastError.message })
    } else {
      popupInfo("reconnect-native request acknowledged")
    }
    setTimeout(() => {
      reconnect.disabled = false
      requestStatus()
    }, 500)
  })
})

popupInfo("popup initialized", {
  chromeMajorVersion: chromeMajorVersion(),
  supportsPopupPermissionPrompt: supportsPopupPermissionPrompt()
})
requestStatus()
setInterval(requestStatus, 1000)
