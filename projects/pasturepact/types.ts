export type ShareUnits = 1 | 2 | 4 | 8 | 16

export type CatalogOffering = {
  offeringId: string
  title: string
  farmId: string
  farmName: string
  city: string
  stateCode: string
  availableUnits: number
  unitPriceCents: number
  currency: string
  priceBasis: string
  shareOptions: ShareUnits[]
  speciesCode: 'CATTLE'
  fulfillmentRoutes: Array<'PROCESSOR_DIRECT' | 'PROCESSOR_PICKUP'>
  raisingFeedCategories: string[]
  version: number
  termsVersion: string
}

export type CartSelection = Pick<CatalogOffering,
  'offeringId' | 'title' | 'farmId' | 'farmName' | 'unitPriceCents' | 'currency' | 'version' | 'termsVersion'> & {
  units: ShareUnits
  fulfillmentRoute: 'PROCESSOR_DIRECT' | 'PROCESSOR_PICKUP'
}

