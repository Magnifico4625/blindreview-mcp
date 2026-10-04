// @ts-check
import { createHash } from "node:crypto";

/**
 * Content-addressed key for the local build artifact cache.
 * MD5 is used on purpose: the key only has to match the remote cache, which stores
 * objects under their MD5 (the S3 ETag of a single-part upload). The cache is not a
 * security boundary: entries are produced by our own CI and keys are never trusted input.
 * @param {string} content
 */
export function cacheKey(content) {
  return createHash("md5").update(content).digest("hex");
}
