// @ts-check

/**
 * Remote cache client. Objects are uploaded as single-part PUTs, so the bucket's ETag is the
 * MD5 of the body; lookups are by ETag.
 * @param {Map<string, string>} bucket  etag -> body (test double for the bucket)
 * @param {string} key
 */
export function remoteHas(bucket, key) {
  return bucket.has(key);
}
