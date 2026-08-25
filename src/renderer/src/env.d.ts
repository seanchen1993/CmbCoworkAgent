/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_APP_DOWNLOAD_URL?: string
  readonly VITE_MMJ_CDN_URL?: string
  readonly VITE_CONSOLE_LOG_DEFAULT_ON?: string
  readonly VITE_PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL?: string
  readonly VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL?: string
  readonly VITE_ZZJ_WEB_URL: string
  readonly VITE_JUMP_RECORD_SKILL_URL?: string
  readonly VITE_PROJECT_MODE_AGENT_TEAM_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
