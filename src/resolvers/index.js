import Resolver from '@forge/resolver';
import { defineConfigResolvers } from './config.js';
import { defineSyncResolvers } from './sync.js';
import { defineDataResolvers } from './data.js';
import { defineStatsResolvers } from './stats.js';
import { defineAuditResolvers } from './audit.js';
import { defineDiagnosticsResolvers } from './diagnostics.js';
import { createAuthorizedDefinitions } from './authorization.js';

const resolver = new Resolver();

// Register all resolver groups.
defineConfigResolvers(resolver);
defineSyncResolvers(resolver);
defineDataResolvers(resolver);
defineStatsResolvers(resolver);
defineAuditResolvers(resolver);
defineDiagnosticsResolvers(resolver);

// Wrap every registered resolver with explicit, default-deny authorization.
// Authorization is enforced here, on the server, before the resolver body runs.
export const handler = createAuthorizedDefinitions(resolver.getDefinitions());
