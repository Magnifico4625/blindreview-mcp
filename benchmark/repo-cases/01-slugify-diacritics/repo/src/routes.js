// @ts-check
import { slugify } from "./slug.js";

/**
 * @param {{ id: number, title: string }} article
 * @returns {string}
 */
export function articlePath(article) {
  return `/articles/${article.id}-${slugify(article.title)}`;
}
