// @ts-check
import { memoize } from "./memoize.js";

/** Resolve a country code to its display name (expensive Intl call). */
export const countryName = memoize(/** @param {string} code */ (code) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code);
