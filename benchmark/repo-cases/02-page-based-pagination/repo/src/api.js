// @ts-check
import { clampLimit, paginate } from "./paginate.js";

/**
 * GET /products?page=&per_page=   (legacy: ?offset=&limit=)
 * `page` is 1-based.
 * @param {Array<{ id: number, name: string }>} products
 * @param {Record<string, string | undefined>} query
 */
export function listProducts(products, query) {
  const perPage = clampLimit(query.per_page ?? query.limit);
  const offset = query.offset !== undefined ? Number(query.offset) : Number(query.page ?? 1) * perPage;
  return paginate(products, offset, perPage);
}
