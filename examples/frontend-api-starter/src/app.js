import { createApi } from "./api.js"

const { createApp, ref, onMounted } = globalThis.Vue
createApp({
  setup() {
    const api = createApi()
    const user = ref(null)
    const overview = ref(null)
    const statuses = ref([])
    const warehouses = ref([])
    const inventory = ref([])
    const trends = ref([])
    const orders = ref([])
    const page = ref(1)
    const total = ref(0)
    const q = ref("")
    const status = ref("")
    const warehouse = ref("east")
    const detail = ref(null)
    const error = ref("")
    const notificationError = ref("")
    const loading = ref(false)
    const orderLoading = ref(false)
    const money = (value) => Number(value).toFixed(2)
    async function loadOrders() {
      orderLoading.value = true
      error.value = ""
      try {
        const result = await api.orders({
          page: page.value,
          pageSize: 3,
          q: q.value,
          status: status.value
        })
        orders.value = result.items
        page.value = result.page
        total.value = result.total
      } catch (cause) {
        error.value = cause.message
      } finally {
        orderLoading.value = false
      }
    }
    async function search() {
      // TODO(search): reset page to 1 and reload orders using current filters.
    }
    async function turnPage(delta) {
      void delta
      // TODO(page): change page within [1, ceil(total / 3)] and reload orders.
    }
    async function showDetail(id) {
      void id
      // TODO(detail): fetch selected detail; show failures and clear stale detail.
    }
    async function changeWarehouse() {
      // TODO(warehouse): reload inventory for the chosen warehouse; show failures.
    }
    async function refresh() {
      loading.value = true
      error.value = ""
      try {
        const result = await Promise.all([
          api.session(),
          api.overview(),
          api.statuses(),
          api.warehouses(),
          api.inventory(warehouse.value),
          api.trends()
        ])
        ;[
          user.value,
          overview.value,
          statuses.value,
          warehouses.value,
          inventory.value,
          trends.value
        ] = result
        await loadOrders()
      } catch (cause) {
        error.value = cause.message
      } finally {
        loading.value = false
      }
      try {
        await api.notifications()
        notificationError.value = ""
      } catch (cause) {
        notificationError.value = cause.message
      }
    }
    onMounted(refresh)
    return {
      user,
      overview,
      statuses,
      warehouses,
      inventory,
      trends,
      orders,
      page,
      total,
      q,
      status,
      warehouse,
      detail,
      error,
      notificationError,
      loading,
      orderLoading,
      money,
      refresh,
      search,
      turnPage,
      showDetail,
      changeWarehouse
    }
  }
}).mount("#app")
