/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHATX_WS_URL?: string
  readonly VITE_CHATX_HTTP_URL?: string
  readonly VITE_CHATX_CHANNEL?: string
  readonly VITE_CHATX_CALLBACK_URL?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_RENDER_URL?: string
  /** Smart routing Layer 3 classifier — internal fallback model (injected at build time for internal builds) */
  readonly VITE_ROUTING_CLASSIFIER_MODEL?: string
  readonly VITE_ROUTING_CLASSIFIER_API_KEY?: string
  readonly VITE_ROUTING_CLASSIFIER_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
