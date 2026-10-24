import { createHash } from 'crypto';
import kvs, { Filter, FilterConditions as C } from '@forge/kvs';
import api, { route } from '../jira/guarded-api.js';
import * as storage from '../storage/kvs.js';
import { acquireIssueLease, releaseIssueLease, assertIssueLeaseOwned, ISSUE_LEASE_ENTITY } from '../sync/issue-lease.js';
import { runWithIssueLease } from '../sync/issue-lease-context.js';
import { assertPilotWritesAllowed } from '../sync/pilot-pause.js';
import { readCommentJson, commentReadBudget } from '../jira/comment-read.js';

const MAX_PAGES_PER_RUN = 10;
const MAX_SCAN_PAGES = 10000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_DEFERRED_ISSUES = 100;
const DEFERRED_RETRIES_PER_RUN = 5;
const validToken = token => typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
const validKey = key => typeof key === 'string' && /^[A-Z][A-Z0-9_]*-\d+$/.test(key);

export function scheduledScopeSignature(org, scheduled) {
  return createHash('sha256').update(JSON.stringify([
    org.id || 'legacy', org.allowedProjects, org.jqlFilter || '', org.syncDirection,
    org.remoteUrl, org.remoteProjectKey, scheduled?.enabled, scheduled?.syncScope
  ])).digest('hex');
}

function validateProgress(value) {
  if (!value || value.version !== 1 || typeof value.signature !== 'string' || typeof value.complete !== 'boolean'
      || typeof value.pageLoaded !== 'boolean' || typeof value.isLast !== 'boolean'
      || !Array.isArray(value.remaining) || value.remaining.length > 100 || !value.remaining.every(validKey)
      || !Array.isArray(value.seenTokens) || value.seenTokens.length > 20 || !value.seenTokens.every(validToken)
      || !Number.isSafeInteger(value.pages) || value.pages < 0 || value.pages > MAX_SCAN_PAGES
      || (value.nextPageToken !== null && !validToken(value.nextPageToken))
      || (value.complete && (!value.pageLoaded || !value.isLast || value.remaining.length || value.nextPageToken !== null))
      || (!value.pageLoaded && value.remaining.length > 0)
      || (value.pageLoaded && !value.isLast && !validToken(value.nextPageToken))
      || (value.retryDeferredFirst !== undefined && typeof value.retryDeferredFirst !== 'boolean')
      || (value.deferred !== undefined && (!Array.isArray(value.deferred)
        || value.deferred.length > MAX_DEFERRED_ISSUES || !value.deferred.every(validKey)
        || new Set(value.deferred).size !== value.deferred.length
        || (value.complete && value.deferred.length > 0)))) {
    throw new Error('Scheduled scan progress is invalid; inspection required');
  }
}

/** A progress write and its ownership predicate commit in the same transaction. */
async function save(key, progress, lease) {
  await assertIssueLeaseOwned(lease);
  await kvs.transact().check(lease.key, { entityName: ISSUE_LEASE_ENTITY,
    conditions: new Filter().and('leaseToken', C.equalTo(lease.token)).and('expiresAt', C.greaterThan(Date.now())) })
    .set(key, progress).execute();
}

export async function runScheduledScan({ orgId, signature, jql, deadline, isCurrent, onIssue }) {
  const lease = await acquireIssueLease({ orgId, sourceKey: 'scheduled-search-v1', ttlSeconds: 900 });
  if (!lease.acquired) return { complete: false, reason: lease.status };
  try {
    return await runWithIssueLease(lease, async () => {
      const key = `scheduled-scan:${orgId}`;
      let progress = await storage.get(key);
      const hasProgress = progress !== null && progress !== undefined;
      if (hasProgress) validateProgress(progress);
      // Older progress records contain no deferred list. Their current head
      // remains in `remaining` until an owned atomic transfer below succeeds.
      const deferred = progress?.deferred || [];
      const retryDeferredFirst = progress?.retryDeferredFirst === true;
      if (!hasProgress || progress.signature !== signature || progress.complete
          || (progress.pageLoaded && progress.isLast && progress.remaining.length === 0)) {
        progress = { version: 1, signature, complete: false, remaining: [], nextPageToken: null,
          seenTokens: [], pages: 0, pageLoaded: false, isLast: false, deferred, retryDeferredFirst };
        await save(key, progress, lease);
      }
      progress = { ...progress, deferred };
      const result = (reason, scanComplete = false) => ({ complete: progress.complete, reason, scanComplete,
        deferredCount: progress.deferred.length, deferredIssues: [...progress.deferred] });
      const stopReason = async () => {
        if (Date.now() >= deadline) return 'execution-budget';
        if (!await isCurrent()) return 'configuration-changed';
        await assertPilotWritesAllowed('scheduled_scan');
        return null;
      };
      const attempted = new Set();
      const retryKeys = progress.deferred.slice(0, DEFERRED_RETRIES_PER_RUN);
      if (retryKeys.length) {
        // Alternate primary-scan and deferred priority. Persist the next turn
        // BEFORE slow work: even a crash cannot give one failing issue every
        // invocation's entire budget or exclude reconsideration forever.
        progress = { ...progress, retryDeferredFirst: !retryDeferredFirst };
        await save(key, progress, lease);
      }
      const retryDeferred = async () => {
        for (const issueKey of retryKeys) {
          if (attempted.has(issueKey)) continue;
          const stopped = await stopReason();
          if (stopped) return stopped;
          const others = progress.deferred.filter(key => key !== issueKey);
          // Rotate durably before work so termination cannot leave one slow
          // retry permanently ahead of every other unresolved issue.
          progress = { ...progress, deferred: [...others, issueKey] };
          await save(key, progress, lease);
          const applied = await onIssue(issueKey);
          attempted.add(issueKey);
          if (applied) {
            progress = { ...progress, deferred: others, complete: progress.pageLoaded && progress.isLast
              && progress.remaining.length === 0 && others.length === 0 };
            await save(key, progress, lease);
          }
        }
        return null;
      };
      let fetched = 0;
      const scan = async () => {
        while (!progress.complete) {
          const stopped = await stopReason();
          if (stopped) return result(stopped);
          if (!progress.pageLoaded) {
            if (fetched >= MAX_PAGES_PER_RUN || progress.pages >= MAX_SCAN_PAGES) {
              return result('page-budget');
            }
            const budget = commentReadBudget();
            budget.deadline = Math.min(budget.deadline, deadline);
            const data = await readCommentJson(() => api.asApp().requestJira(route`/rest/api/3/search/jql`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jql, maxResults: 100, fields: ['key'],
                ...(progress.nextPageToken ? { nextPageToken: progress.nextPageToken } : {}) })
            }), budget);
            if (!Array.isArray(data?.issues) || data.issues.length > 100 || !data.issues.every(issue => validKey(issue?.key))
                || typeof data.isLast !== 'boolean' || data.warningMessages?.length || data.errorMessages?.length
                || (!data.isLast && (!validToken(data.nextPageToken) || progress.seenTokens.includes(data.nextPageToken)))) {
              throw new Error('Scheduled search is incomplete or malformed; scan remains incomplete');
            }
            const token = data.isLast ? null : data.nextPageToken;
            progress = { ...progress, remaining: data.issues.map(issue => issue.key), pageLoaded: true,
              nextPageToken: token, isLast: data.isLast, pages: progress.pages + 1,
              seenTokens: token ? [...progress.seenTokens, token].slice(-20) : progress.seenTokens };
            // Persist exact page identities before any issue writes. A resumed scan
            // drains this page even if subsequent search results have changed.
            await save(key, progress, lease);
            fetched++;
            continue;
          }
          if (progress.remaining.length) {
            const issueKey = progress.remaining[0];
            if (progress.deferred.includes(issueKey)) {
              // Primary coverage must not undo retry-window rotation or count
              // an encounter as a retry. Preserve the deferred order exactly.
              progress = { ...progress, remaining: progress.remaining.slice(1) };
              await save(key, progress, lease);
              continue;
            }
            const applied = attempted.has(issueKey) ? true : await onIssue(issueKey);
            attempted.add(issueKey);
            let deferred = progress.deferred;
            if (!applied) {
              if (deferred.length >= MAX_DEFERRED_ISSUES) {
                // Bounded backpressure: retain this exact unprocessed head too.
                // A later successful reconsideration frees space; nothing drops.
                return result('deferred-capacity');
              }
              deferred = [...deferred, issueKey];
            }
            // Moving a failed item and advancing SEARCH coverage commit together.
            // Neither action updates that issue's synchronization success state.
            progress = { ...progress, deferred, remaining: progress.remaining.slice(1) };
            await save(key, progress, lease);
            continue;
          }
          if (progress.isLast) {
            progress = { ...progress, complete: progress.deferred.length === 0 };
            await save(key, progress, lease);
            return result(progress.complete ? 'last-page-drained' : 'deferred-work', true);
          }
          progress = { ...progress, pageLoaded: false };
          await save(key, progress, lease);
        }
        return result('last-page-drained', true);
      };
      if (retryDeferredFirst) {
        const stopped = await retryDeferred();
        if (stopped) return result(stopped);
      }
      const scanResult = await scan();
      if (!retryDeferredFirst && !['execution-budget', 'configuration-changed'].includes(scanResult.reason)) {
        const stopped = await retryDeferred();
        if (stopped) return result(stopped, scanResult.scanComplete);
      }
      return result(progress.complete ? 'last-page-drained' : scanResult.reason, scanResult.scanComplete);
    });
  } finally { await releaseIssueLease(lease); }
}
