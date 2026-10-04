// @ts-check

/** @param {number[]} orderTotalsCents */
export function revenueCents(orderTotalsCents) {
  return orderTotalsCents.reduce((a, b) => a + b, 0);
}

/**
 * Average order value for the dashboard tile, as a display string ("12.35").
 * Display-only: nothing is stored or billed from this value; the ledger keeps integer cents.
 * Floating point is fine here because the result is rounded once for display.
 * @param {number[]} orderTotalsCents
 */
export function averageOrderValueLabel(orderTotalsCents) {
  if (orderTotalsCents.length === 0) return "0.00";
  return (revenueCents(orderTotalsCents) / orderTotalsCents.length / 100).toFixed(2);
}
