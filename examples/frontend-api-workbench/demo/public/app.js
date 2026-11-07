/* global Vue */
const { createApp, ref, computed, onMounted } = Vue
createApp({
  setup() {
    const session = ref(null),
      overview = ref(null),
      statuses = ref([]),
      orders = ref([])
    const total = ref(0),
      page = ref(1),
      pageSize = 3,
      query = ref(""),
      status = ref("")
    const warehouse = ref("east"),
      warehouses = ref([]),
      inventory = ref([]),
      trends = ref([]),
      notifications = ref([])
    const detail = ref(null),
      detailOpen = ref(false),
      loading = ref(false)
    const errors = ref({}),
      initialReady = ref(false)
    let listRevision = 0,
      stockRevision = 0,
      detailRevision = 0
    const money = (cents) => (Number(cents) / 100).toFixed(2)
    const statusLabel = (value) =>
      statuses.value.find((item) => item.value === value)?.label ?? value
    const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
    const maxTrend = computed(() => Math.max(1, ...trends.value.map((point) => point.revenueCents)))
    async function api(url) {
      const response = await fetch(url)
      const data = await response.json()
      if (!response.ok) throw Error(response.status + " · " + (data.message ?? "请求失败"))
      return data
    }
    async function loadOrders() {
      const revision = ++listRevision
      loading.value = true
      errors.value.orders = ""
      try {
        // Deliberate integration defect: UI is one-based but request is zero-based.
        const params = new URLSearchParams({
          page: String(page.value - 1),
          pageSize: String(pageSize),
          q: query.value,
          status: status.value
        })
        const data = await api("/api/orders?" + params)
        if (revision !== listRevision) return
        orders.value = data.orders
        total.value = data.total
      } catch (error) {
        if (revision === listRevision) errors.value.orders = error.message
      } finally {
        if (revision === listRevision) loading.value = false
      }
    }
    function search() {
      page.value = 1
      return loadOrders()
    }
    function movePage(value) {
      page.value = value
      return loadOrders()
    }
    async function loadInventory() {
      const revision = ++stockRevision
      errors.value.inventory = ""
      try {
        const data = await api("/api/inventory?warehouse=" + warehouse.value)
        if (revision === stockRevision) inventory.value = data.items
      } catch (error) {
        if (revision === stockRevision) errors.value.inventory = error.message
      }
    }
    async function openDetail(id) {
      const revision = ++detailRevision
      detailOpen.value = true
      detail.value = null
      errors.value.detail = ""
      try {
        const data = await api("/api/orders/" + encodeURIComponent(id))
        if (revision === detailRevision) detail.value = data.order
      } catch (error) {
        if (revision === detailRevision) errors.value.detail = error.message
      }
    }
    function closeDetail() {
      detailRevision++
      detailOpen.value = false
    }
    async function loadNotifications() {
      // Deliberate integration defect: failed requests are presented as successful empty lists.
      try {
        notifications.value = (await api("/api/notifications")).items
      } catch {
        notifications.value = []
      }
    }
    async function initial(name, url, assign) {
      try {
        assign(await api(url))
      } catch (error) {
        errors.value[name] = error.message
      }
    }
    onMounted(async () => {
      await Promise.all([
        initial("session", "/api/session", (data) => {
          session.value = data
        }),
        initial("overview", "/api/overview", (data) => {
          overview.value = data
        }),
        initial("statuses", "/api/order-statuses", (data) => {
          statuses.value = data.statuses
        }),
        initial("warehouses", "/api/warehouses", (data) => {
          warehouses.value = data.warehouses
        }),
        initial("trends", "/api/trends", (data) => {
          trends.value = data.points
        }),
        loadOrders(),
        loadInventory(),
        loadNotifications()
      ])
      initialReady.value = true
    })
    return {
      session,
      overview,
      statuses,
      orders,
      total,
      page,
      pageSize,
      query,
      status,
      warehouse,
      warehouses,
      inventory,
      trends,
      notifications,
      detail,
      detailOpen,
      loading,
      errors,
      initialReady,
      money,
      statusLabel,
      totalPages,
      maxTrend,
      search,
      movePage,
      loadInventory,
      openDetail,
      closeDetail,
      loadNotifications
    }
  }
}).mount("#app")
