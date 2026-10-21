import { defineConfigResolvers } from './config.js';
import { defineSyncResolvers } from './sync.js';
import { defineDataResolvers } from './data.js';
import { defineStatsResolvers } from './stats.js';
import { defineAuditResolvers } from './audit.js';
import { defineDiagnosticsResolvers } from './diagnostics.js';
import { createAuthorizedResolver } from './authorization.js';

const resolver = createAuthorizedResolver();

// Register all resolver groups. authorization wraps each implementation at
// registration time, before getDefinitions() creates the Forge handler.
defineConfigResolvers(resolver);
defineSyncResolvers(resolver);
defineDataResolvers(resolver);
defineStatsResolvers(resolver);
defineAuditResolvers(resolver);
defineDiagnosticsResolvers(resolver);

export const registeredResolverNames = resolver.getRegisteredNames();

// getDefinitions() returns the callable Forge resolver handler. It must be
// exported directly, not enumerated or transformed into an object map.
export const handler = resolver.getDefinitions();
