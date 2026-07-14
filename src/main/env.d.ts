/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHATX_WS_URL?: string
  readonly VITE_CHATX_HTTP_URL?: string
  readonly VITE_CHATX_CHANNEL?: string
  readonly VITE_CHATX_CALLBACK_URL?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_ENTERPRISE_PROJECT_QUERY_URL?: string
  readonly VITE_ENTERPRISE_PROJECT_LIST?: string
  readonly VITE_DEPLOY_UNIT_QUERY_URL?: string
  readonly VITE_DEPLOY_UNIT_QUERY_MOCK?: string
  readonly VITE_LEANSTAR_REVIEW_GATEWAY_URL?: string
  readonly VITE_LEANSTAR_PROJECT_REVIEW_URL_TEMPLATE?: string
  readonly VITE_LEANSTAR_PERSONAL_TOKEN_URL?: string
  readonly VITE_ENTERPRISE_PROJECT_QUERY_MOCK?: string
  readonly VITE_ES_INDEX_SKILL_EVAL?: string
  readonly VITE_TRACE_EVOLVER_REVIEW_ADMIN_YST_IDS?: string
  readonly VITE_ADMIN_YST_IDS?: string
  readonly VITE_DASHBOARD_AWARDS_ADMIN_YST_IDS?: string
  readonly VITE_RENDER_URL?: string
  readonly VITE_PROJECT_MODE_MEMORY_ENABLED?: string
  /** Smart routing Layer 3 classifier — internal fallback model (injected at build time for internal builds) */
  readonly VITE_ROUTING_CLASSIFIER_MODEL?: string
  readonly VITE_ROUTING_CLASSIFIER_API_KEY?: string
  readonly VITE_ROUTING_CLASSIFIER_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
