/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_MMJ_CDN_URL?: string
  readonly VITE_CONSOLE_LOG_DEFAULT_ON?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
