import type { MarketItem } from "./market"
import { marketListItems as readMarketListItems } from "../../../shared/market-list-response"

export const marketListItems = readMarketListItems<MarketItem>
