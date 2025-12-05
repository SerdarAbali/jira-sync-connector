/**
 * Centralized KVS wrapper using @forge/kvs
 * 
 * Migration from @forge/api storage to @forge/kvs:
 * - Transactions are only available via @forge/kvs
 * - query().where() uses WhereConditions.beginsWith instead of startsWith
 * - Error handling: KEY_NOT_FOUND instead of UNDEFINED for missing keys
 * 
 * @see https://developer.atlassian.com/platform/forge/storage-reference/kvs-migration-from-legacy/
 */
import { kvs, WhereConditions } from '@forge/kvs';

// Re-export for use in other modules
export { kvs, WhereConditions };

/**
 * Get a value from storage, returns null if not found (consistent with legacy behavior)
 */
export async function get(key) {
  try {
    return await kvs.get(key);
  } catch (error) {
    // KEY_NOT_FOUND is the new error for missing keys
    if (error.code === 'KEY_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/**
 * Set a value in storage with optional TTL
 */
export async function set(key, value, options = {}) {
  if (options.ttl) {
    // @forge/kvs doesn't support TTL directly on set - use separate mechanism if needed
    // For now, store with metadata for manual TTL checking
    return await kvs.set(key, { value, expiresAt: Date.now() + options.ttl });
  }
  return await kvs.set(key, value);
}

/**
 * Delete a value from storage
 */
export async function del(key) {
  try {
    return await kvs.delete(key);
  } catch (error) {
    // Ignore KEY_NOT_FOUND errors on delete
    if (error.code === 'KEY_NOT_FOUND') {
      return;
    }
    throw error;
  }
}

/**
 * Get a secret from storage
 */
export async function getSecret(key) {
  try {
    return await kvs.getSecret(key);
  } catch (error) {
    if (error.code === 'KEY_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/**
 * Set a secret in storage
 */
export async function setSecret(key, value) {
  return await kvs.setSecret(key, value);
}

/**
 * Delete a secret from storage
 */
export async function deleteSecret(key) {
  try {
    return await kvs.deleteSecret(key);
  } catch (error) {
    if (error.code === 'KEY_NOT_FOUND') {
      return;
    }
    throw error;
  }
}

/**
 * Query keys by prefix using kvs.query()
 * This replaces the pattern of maintaining separate index arrays
 * 
 * @param {string} prefix - Key prefix to search for
 * @param {number} limit - Maximum results (default 100)
 * @returns {Promise<Array<{key: string, value: any}>>}
 */
export async function queryByPrefix(prefix, limit = 100) {
  const results = [];
  let cursor = null;
  
  do {
    const query = kvs.query()
      .where('key', WhereConditions.beginsWith(prefix))
      .limit(Math.min(limit - results.length, 100));
    
    if (cursor) {
      query.cursor(cursor);
    }
    
    const response = await query.getMany();
    results.push(...response.results);
    cursor = response.nextCursor;
  } while (cursor && results.length < limit);
  
  return results;
}

/**
 * Create a transaction builder for atomic operations
 * Max 25 operations per transaction
 * 
 * @example
 * await transaction()
 *   .set('key1', 'value1')
 *   .set('key2', 'value2')
 *   .delete('key3')
 *   .execute();
 */
export function transaction() {
  return kvs.transact();
}

/**
 * Batch get multiple keys
 * More efficient than multiple individual gets
 */
export async function getMany(keys) {
  const results = {};
  // kvs doesn't have batch get, so we parallelize
  const values = await Promise.all(keys.map(key => get(key)));
  keys.forEach((key, i) => {
    results[key] = values[i];
  });
  return results;
}
