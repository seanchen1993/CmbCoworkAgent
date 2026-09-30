/* global chrome */

const NATIVE_HOST_NAME = "com.cmbcoworkagent.browser"
const PROTOCOL_VERSION = 1
const MAX_COOKIES = 10000
const MAX_COOKIE_VALUE_CHARS = 200000
const MAX_CHUNK_BYTES = 512 * 1024
const RECONNECT_DELAYS_MS = [1000, 3000, 10000]
const STABLE_CONNECTION_MS = 30000
const SERVICE_WORKER_LOG_PREFIX = "[CmbBrowserExtension][ServiceWorker]"

let nativePort = null
let appConnected = false
let appConnectionError = ""
let profileInstanceId = null
let reconnectTimer = null
let stableConnectionTimer = null
let reconnectAttempt = 0
let hasConnectedSuccessfully = false
const cancelledRequests = new Set()
const activeExportRequests = new Set()
let lastHostStatusSignature = ""
let lastPopupStatusResponseSignature = ""

function serviceWorkerLog(method, message, details) {
  if (typeof console === "undefined") return
  const writer = console[method]
  if (typeof writer !== "function") return
  if (details === undefined) {
    writer.call(console, `${SERVICE_WORKER_LOG_PREFIX} ${message}`)
    return
  }
  writer.call(console, `${SERVICE_WORKER_LOG_PREFIX} ${message}`, details)
}

function swInfo(message, details) {
  serviceWorkerLog("info", message, details)
}

function swWarn(message, details) {
  serviceWorkerLog("warn", message, details)
}

function swError(message, details) {
  serviceWorkerLog("error", message, details)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function summarizeHostStatus(message) {
  return {
    connected: message?.connected === true,
    protocolVersion:
      typeof message?.protocolVersion === "number" ? message.protocolVersion : undefined,
    error:
      typeof message?.error === "string" && message.error
        ? message.error
        : undefined
  }
}

function logHostStatusChange(message) {
  const summary = summarizeHostStatus(message)
  const signature = JSON.stringify(summary)
  if (signature === lastHostStatusSignature) return
  lastHostStatusSignature = signature
  if (summary.connected) swInfo("host-status updated", summary)
  else swWarn("host-status updated", summary)
}

function callChromeCallbackApi(apiName, invoke) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    try {
      const maybePromise = invoke((value) => {
        const error = chrome.runtime.lastError
        if (error) {
          const wrapped = new Error(error.message || "Chrome API 调用失败")
          swWarn(`${apiName} callback returned runtime.lastError`, { error: wrapped.message })
          fail(wrapped)
          return
        }
        finish(value)
      })
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish, fail)
      }
    } catch (error) {
      swWarn(`${apiName} threw`, { error: errorMessage(error) })
      fail(error)
    }
  })
}

function storageLocalGet(keys) {
  return callChromeCallbackApi("chrome.storage.local.get", (resolve) =>
    chrome.storage.local.get(keys, resolve)
  )
}

function storageLocalSet(items) {
  return callChromeCallbackApi("chrome.storage.local.set", (resolve) =>
    chrome.storage.local.set(items, resolve)
  )
}

function permissionsContains(origins) {
  return callChromeCallbackApi("chrome.permissions.contains", (resolve) =>
    chrome.permissions.contains({ origins }, resolve)
  )
}

function getAllCookieStores() {
  return callChromeCallbackApi("chrome.cookies.getAllCookieStores", (resolve) =>
    chrome.cookies.getAllCookieStores(resolve)
  )
}

function getAllCookies(query) {
  return callChromeCallbackApi("chrome.cookies.getAll", (resolve) =>
    chrome.cookies.getAll(query, resolve)
  )
}

function sendNative(message, port = nativePort) {
  if (!port || port !== nativePort) throw new Error("CmbCoworkAgent 未连接")
  port.postMessage(message)
}

function cookieIsSafe(value) {
  return (
    value &&
    typeof value.name === "string" &&
    value.name.length <= 4096 &&
    typeof value.value === "string" &&
    value.value.length <= MAX_COOKIE_VALUE_CHARS &&
    typeof value.domain === "string" &&
    value.domain.length <= 4096 &&
    typeof value.path === "string" &&
    value.path.length <= 4096
  )
}

function cookieForTransport(cookie) {
  return {
    domain: cookie.domain,
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    httpOnly: cookie.httpOnly === true,
    name: cookie.name,
    ...(cookie.partitionKey !== undefined ? { partitionKey: cookie.partitionKey } : {}),
    path: cookie.path,
    ...(typeof cookie.sameSite === "string" ? { sameSite: cookie.sameSite } : {}),
    secure: cookie.secure === true,
    ...(typeof cookie.session === "boolean" ? { session: cookie.session } : {}),
    ...(typeof cookie.storeId === "string" ? { storeId: cookie.storeId } : {}),
    value: cookie.value
  }
}

function chunkCookies(cookies) {
  const chunks = []
  let current = []
  let currentBytes = 2
  const encoder = new TextEncoder()
  for (const cookie of cookies) {
    const candidate = cookieForTransport(cookie)
    const candidateBytes = encoder.encode(JSON.stringify(candidate)).length
    const separatorBytes = current.length > 0 ? 1 : 0
    if (current.length > 0 && currentBytes + separatorBytes + candidateBytes > MAX_CHUNK_BYTES) {
      chunks.push(current)
      current = [candidate]
      currentBytes = 2 + candidateBytes
    } else {
      current.push(candidate)
      currentBytes += separatorBytes + candidateBytes
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function hasHostPermission() {
  return permissionsContains(["http://*/*", "https://*/*"])
}

function chooseNormalCookieStore(stores) {
  // Incognito access is disabled by default. Chrome's regular profile store uses id "0".
  return stores.find((store) => store.id === "0") || stores[0]
}

async function exportCookies(requestId, port) {
  if (activeExportRequests.has(requestId)) {
    swWarn("duplicate cookie export request ignored", { requestId })
    throw new Error("Cookie 导出请求正在进行")
  }
  activeExportRequests.add(requestId)
  swInfo("cookie export started", { requestId })

  try {
    const permissionGranted = await hasHostPermission()
    if (!permissionGranted) {
      swWarn("cookie export blocked because host permission is missing", { requestId })
      sendNative(
        {
          type: "cookie-export-error",
          code: "permission_required",
          message: "请允许 CmbCoworkAgent 访问网站 Cookie",
          requestId
        },
        port
      )
      return
    }

    const stores = await getAllCookieStores()
    const normalStore = chooseNormalCookieStore(stores)
    const cookies = await getAllCookies(normalStore ? { storeId: normalStore.id } : {})
    const safeCookies = cookies.filter(cookieIsSafe)
    const exportedCookies = safeCookies.slice(0, MAX_COOKIES)
    const skipped = cookies.length - exportedCookies.length
    const chunks = chunkCookies(exportedCookies)
    swInfo("cookie export prepared", {
      requestId,
      storeCount: stores.length,
      selectedStoreId: normalStore?.id || "(none)",
      totalCookies: cookies.length,
      exportedCookies: exportedCookies.length,
      skippedCookies: skipped,
      chunkCount: chunks.length
    })
    if (cancelledRequests.has(requestId)) return
    sendNative(
      { type: "cookie-export-begin", requestId, skipped, total: exportedCookies.length },
      port
    )
    for (let index = 0; index < chunks.length; index += 1) {
      if (cancelledRequests.has(requestId)) return
      sendNative({ type: "cookie-export-chunk", requestId, index, cookies: chunks[index] }, port)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (cancelledRequests.has(requestId)) return
    sendNative(
      { type: "cookie-export-complete", requestId, skipped, total: exportedCookies.length },
      port
    )
    swInfo("cookie export completed", {
      requestId,
      exportedCookies: exportedCookies.length,
      skippedCookies: skipped,
      chunkCount: chunks.length
    })
  } finally {
    activeExportRequests.delete(requestId)
    cancelledRequests.delete(requestId)
  }
}

function sendReady(port) {
  storageLocalGet(["profileInstanceId"])
    .then((value) => {
      profileInstanceId = value.profileInstanceId || crypto.randomUUID()
      return storageLocalSet({ profileInstanceId })
    })
    .then(() => {
      swInfo("sending extension-ready", {
        extensionVersion: chrome.runtime.getManifest().version,
        profileInstanceId
      })
      sendNative(
        {
          type: "extension-ready",
          extensionVersion: chrome.runtime.getManifest().version,
          profileInstanceId,
          protocolVersion: PROTOCOL_VERSION
        },
        port
      )
    })
    .catch((error) => {
      swWarn("failed to prepare extension-ready payload", { error: errorMessage(error) })
    })
}

function clearReconnectTimer() {
  if (!reconnectTimer) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function clearStableConnectionTimer() {
  if (!stableConnectionTimer) return
  clearTimeout(stableConnectionTimer)
  stableConnectionTimer = null
}

function resetReconnectBudget() {
  clearReconnectTimer()
  clearStableConnectionTimer()
  reconnectAttempt = 0
  swInfo("reconnect budget reset")
}

function markConnected(port) {
  hasConnectedSuccessfully = true
  clearStableConnectionTimer()
  swInfo("native host marked connected", {
    reconnectAttempt,
    profileInstanceId,
    portActive: nativePort === port
  })
  if (reconnectAttempt === 0) return

  // A short-lived reconnect does not replenish the retry budget and cannot flap forever.
  stableConnectionTimer = setTimeout(() => {
    stableConnectionTimer = null
    if (nativePort === port && appConnected) {
      reconnectAttempt = 0
      swInfo("reconnect budget restored after stable connection")
    }
  }, STABLE_CONNECTION_MS)
}

function scheduleReconnect() {
  if (reconnectTimer || nativePort || !hasConnectedSuccessfully) return
  if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) return

  const delay = RECONNECT_DELAYS_MS[reconnectAttempt]
  reconnectAttempt += 1
  swWarn("scheduling reconnect", {
    delay,
    attemptNumber: reconnectAttempt,
    maxAttempts: RECONNECT_DELAYS_MS.length
  })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    swInfo("running scheduled reconnect", { delay, attemptNumber: reconnectAttempt })
    connectNative()
  }, delay)
}

function connectNative(force = false) {
  swInfo("connectNative invoked", {
    force,
    hasActivePort: nativePort !== null,
    reconnectAttempt,
    hasConnectedSuccessfully
  })
  if (force && nativePort) {
    const previousPort = nativePort
    nativePort = null
    swInfo("disconnecting previous native port before forced reconnect")
    previousPort.disconnect()
  }
  if (nativePort) return
  if (reconnectTimer) return
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    nativePort = port
    swInfo("native host port created", { nativeHostName: NATIVE_HOST_NAME })
    port.onMessage.addListener((message) => {
      if (nativePort !== port) return
      if (message?.type === "host-status") {
        logHostStatusChange(message)
        appConnected = message.connected === true && message.protocolVersion === PROTOCOL_VERSION
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          appConnectionError = "桌面应用与扩展的协议版本不一致，请更新后重试"
        }
        if (typeof message.error === "string") appConnectionError = message.error
        else if (appConnected) {
          appConnectionError = ""
          markConnected(port)
        }
        storageLocalSet({ nativeHostError: appConnectionError }).catch((error) => {
          swWarn("failed to persist nativeHostError after host-status", {
            error: errorMessage(error)
          })
        })
        return
      }
      if (message?.type === "export-cookies" && typeof message.requestId === "string") {
        swInfo("received export-cookies request", { requestId: message.requestId })
        exportCookies(message.requestId, port).catch((error) => {
          swWarn("cookie export failed", {
            requestId: message.requestId,
            error: errorMessage(error)
          })
          try {
            sendNative(
              {
                type: "cookie-export-error",
                code: "export_failed",
                message: error?.message || "Cookie 导出失败",
                requestId: message.requestId
              },
              port
            )
          } catch {
            // The original port may have disconnected while the export was running.
          }
        })
        return
      }
      if (message?.type === "cancel-cookie-export" && typeof message.requestId === "string") {
        if (activeExportRequests.has(message.requestId)) {
          swInfo("received cancel-cookie-export", { requestId: message.requestId })
          cancelledRequests.add(message.requestId)
        }
        return
      }
      swWarn("received unsupported message from native host", {
        messageType: message?.type ?? "(unknown)"
      })
    })
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return
      appConnected = false
      appConnectionError = chrome.runtime.lastError?.message || "Native Messaging Host 已断开"
      swWarn("native host disconnected", {
        error: appConnectionError,
        willRetry:
          hasConnectedSuccessfully &&
          reconnectTimer === null &&
          reconnectAttempt < RECONNECT_DELAYS_MS.length
      })
      storageLocalSet({ nativeHostError: appConnectionError }).catch((error) => {
        swWarn("failed to persist nativeHostError after disconnect", {
          error: errorMessage(error)
        })
      })
      clearStableConnectionTimer()
      nativePort = null
      scheduleReconnect()
    })
    sendReady(port)
  } catch (error) {
    appConnected = false
    appConnectionError = error?.message || "无法启动 CmbCoworkAgent Native Messaging Host"
    swError("connectNative failed", { error: appConnectionError })
    storageLocalSet({ nativeHostError: appConnectionError }).catch((storageError) => {
      swWarn("failed to persist nativeHostError after connectNative failure", {
        error: errorMessage(storageError)
      })
    })
    clearStableConnectionTimer()
    nativePort = null
    scheduleReconnect()
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "popup-status") {
    Promise.all([
      storageLocalGet(["nativeHostError"]).catch(() => ({})),
      hasHostPermission().catch(() => false)
    ]).then(([stored, permissionGranted]) => {
      const response = {
        connected: appConnected,
        nativeHostStarted: nativePort !== null,
        nativeHostError:
          appConnectionError ||
          (typeof stored.nativeHostError === "string" ? stored.nativeHostError : ""),
        permissionGranted
      }
      const signature = JSON.stringify(response)
      if (signature !== lastPopupStatusResponseSignature) {
        lastPopupStatusResponseSignature = signature
        swInfo("responding to popup-status", response)
      }
      sendResponse(response)
    }).catch((error) => {
      swWarn("popup-status aggregation failed", { error: errorMessage(error) })
      sendResponse({
        connected: appConnected,
        nativeHostStarted: nativePort !== null,
        nativeHostError: appConnectionError,
        permissionGranted: false
      })
    })
    return true
  }
  if (message?.type === "reconnect-native") {
    swInfo("received reconnect-native request from popup")
    appConnected = false
    appConnectionError = ""
    resetReconnectBudget()
    connectNative(true)
    sendResponse({ reconnecting: true })
    return false
  }
  return false
})

chrome.runtime.onStartup.addListener(() => connectNative())
chrome.runtime.onInstalled.addListener(() => connectNative())
swInfo("service worker initialized", {
  nativeHostName: NATIVE_HOST_NAME,
  protocolVersion: PROTOCOL_VERSION
})
connectNative()
