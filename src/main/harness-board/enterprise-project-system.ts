export function splitMainProduct(mainProduct: string): {
  systemId: string
  systemName: string
} {
  const systemId = mainProduct.match(/^[A-Za-z0-9.]{1,7}/)?.[0] ?? ""
  return {
    systemId,
    systemName: mainProduct.slice(systemId.length).trim()
  }
}
