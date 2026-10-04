// @ts-check

/**
 * @typedef {{ dailyStats(userId: string): { orders: number, revenueCents: number, updatedAt: string } | undefined,
 *             ordersForUser(userId: string): Array<{ totalCents: number, createdAt: string }> }} Db
 */

/**
 * GET /dashboard. Computes the statistics live from the user's orders so they are always fresh.
 * @param {Db} db
 * @param {string} userId
 * @param {() => Date} [now]
 */
export function getDashboard(db, userId, now = () => new Date()) {
  const orders = db.ordersForUser(userId);
  const revenueCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
  return { orders: orders.length, revenueCents, updatedAt: now().toISOString() };
}
