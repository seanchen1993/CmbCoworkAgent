// Implement this adapter against docs/api-correct.txt. Keep the exported API stable.
// Use fetcher so the immutable acceptance tests can exercise real HTTP requests.
export function createApi(base = "", fetcher = globalThis.fetch) {
  void base
  void fetcher
  const pending = async () => {
    throw new Error("TODO：接口尚未接入，请通过工作台补齐 src/api.js")
  }
  return {
    // { user: { name, role }, workspace }
    session: pending,
    // { revenue: yuan number, orderCount, pendingShipment, conversionPercent }
    overview: pending,
    // Array<{ value, label }>
    statuses: pending,
    // ({ page = 1, pageSize = 3, q = "", status = "" })
    // => { items: raw orders plus amount(yuan), page, pageSize, total }
    orders: pending,
    // (id) => raw order plus amount(yuan), including items and shippingAddress
    detail: pending,
    // Array<{ id, name }>
    warehouses: pending,
    // (warehouse) => Array<{ sku, name, available, reserved }>
    inventory: pending,
    // Array<{ day, revenue(yuan) }>
    trends: pending,
    // Reject on non-2xx with the backend message; do not turn failures into empty data.
    notifications: pending
  }
}
