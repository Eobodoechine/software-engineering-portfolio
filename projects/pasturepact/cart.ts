import type { CartSelection } from './types'

const cartKey = 'pasturepact.cart.v1'
const orderKey = 'pasturepact.order-ids.v1'
const commandKey = 'pasturepact.checkout-command.v1'
const retryCommandKey = 'pasturepact.retry-command.v1'

function normalizeSelection(value: unknown): CartSelection | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.offeringId !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.farmId !== 'string' ||
    typeof candidate.farmName !== 'string' ||
    typeof candidate.unitPriceCents !== 'number' ||
    typeof candidate.currency !== 'string' ||
    typeof candidate.version !== 'number' ||
    typeof candidate.termsVersion !== 'string' ||
    ![1, 2, 4, 8, 16].includes(Number(candidate.units))
  ) return null

  const fulfillmentRoute = candidate.fulfillmentRoute === 'PROCESSOR_PICKUP'
    ? 'PROCESSOR_PICKUP'
    : 'PROCESSOR_DIRECT'
  return { ...candidate, units: candidate.units, fulfillmentRoute } as CartSelection
}

function storageKey(demo: boolean) { return demo ? 'pasturepact.demo-cart.v1' : cartKey }

export function readCart(demo = false): CartSelection[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(demo)) ?? '[]')
    return Array.isArray(value)
      ? value.map(normalizeSelection).filter((selection): selection is CartSelection => selection !== null)
      : []
  } catch {
    return []
  }
}

export function saveSelection(selection: CartSelection, demo = false) {
  const cart = readCart(demo).filter((item) => item.offeringId !== selection.offeringId)
  cart.push(selection)
  localStorage.setItem(storageKey(demo), JSON.stringify(cart))
}

export function removeSelection(offeringId: string, demo = false) {
  localStorage.setItem(storageKey(demo), JSON.stringify(readCart(demo).filter((item) => item.offeringId !== offeringId)))
}

export function clearCart(demo = false) {
  localStorage.removeItem(storageKey(demo))
}

export function rememberOrder(cartId: string) {
  const ids = readOrderIds().filter((id) => id !== cartId)
  localStorage.setItem(orderKey, JSON.stringify([cartId, ...ids].slice(0, 20)))
}

export function readOrderIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(localStorage.getItem(orderKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function checkoutCommandId(payload: unknown) {
  const serialized = JSON.stringify(payload)
  try {
    const previous = JSON.parse(localStorage.getItem(commandKey) ?? 'null') as { payload?: string; id?: string } | null
    if (previous?.payload === serialized && typeof previous.id === 'string') return previous.id
  } catch {
    // Replace malformed browser state with a new command identifier.
  }
  const id = crypto.randomUUID()
  localStorage.setItem(commandKey, JSON.stringify({ payload: serialized, id }))
  return id
}

export function clearCheckoutCommand() {
  localStorage.removeItem(commandKey)
}

export function retryCommandId(payload: unknown) {
  const serialized = JSON.stringify(payload)
  try {
    const previous = JSON.parse(localStorage.getItem(retryCommandKey) ?? 'null') as { payload?: string; id?: string } | null
    if (previous?.payload === serialized && typeof previous.id === 'string') return previous.id
  } catch {
    // Replace malformed browser state with a new command identifier.
  }
  const id = crypto.randomUUID()
  localStorage.setItem(retryCommandKey, JSON.stringify({ payload: serialized, id }))
  return id
}

export function clearRetryCommand() {
  localStorage.removeItem(retryCommandKey)
}
