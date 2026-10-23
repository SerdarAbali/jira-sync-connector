import { AsyncLocalStorage } from 'async_hooks';
import { assertIssueLeaseOwned, renewIssueLease } from './issue-lease.js';

const ownership = new AsyncLocalStorage();

export async function runWithIssueLease(lease, callback) {
  const scope = { lease, closed: false };
  const parents = ownership.getStore() || [];
  try {
    return await ownership.run([...parents, scope], callback);
  } finally {
    // Descendant async tasks retain this object and cannot write after return.
    scope.closed = true;
  }
}

export async function assertCurrentIssueLeases() {
  const scopes = ownership.getStore() || [];
  for (const scope of scopes) {
    if (scope.closed) {
      const error = new Error('Issue lease scope has ended');
      error.code = 'LEASE_NOT_OWNED';
      throw error;
    }
    await assertIssueLeaseOwned(scope.lease);
    if (scope.lease.metadata.expiresAt - Date.now() < 60000) {
      await renewIssueLease(scope.lease);
    }
  }
  // Another lease check/renewal above may itself take time. Recheck every
  // local deadline and closed scope after the final await.
  if (scopes.some(scope => scope.closed || scope.lease.metadata.expiresAt <= Date.now())) {
    const error = new Error('Issue lease expired during submission validation');
    error.code = 'LEASE_NOT_OWNED';
    throw error;
  }
}
