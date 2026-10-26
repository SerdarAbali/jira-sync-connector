/**
 * Pairing-witness constants with no imports.
 *
 * These live in their own module so modules that sit on the Jira transport
 * boundary can reference the property key without importing the schema module,
 * which itself imports the guarded transport. Importing the key from here is
 * what keeps `guarded-api → permit → schema → guarded-api` from evaluating the
 * schema before its own imports finish.
 */

export const PAIR_WITNESS_PROPERTY_KEY = 'sync-connector-pair';
export const PAIR_WITNESS_VERSION = 1;
export const PAIR_WITNESS_MAX_VALUE_BYTES = 32768;
export const PAIR_WITNESS_MAX_KEY_BYTES = 255;
