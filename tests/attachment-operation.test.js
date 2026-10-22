const mockStore = new Map();

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  getSecret: jest.fn(async () => null)
}));

import {
  ATTACHMENT_DIRECTIONS,
  ATTACHMENT_OPERATION_CODES,
  ATTACHMENT_OPERATION_STATES,
  beginAttachmentDeletionOperation,
  beginAttachmentUploadOperation,
  buildAttachmentOperationKey,
  getAttachmentOperation,
  markAttachmentDeletionFailedDefinitive,
  markAttachmentDeletionSubmissionStarted,
  markAttachmentDeletionUnknown,
  markAttachmentSubmissionStarted,
  markAttachmentUploadFailedDefinitive,
  markAttachmentUploadSucceeded,
  markAttachmentUploadUnknown,
  markAttachmentWriteStarted,
  resolveAttachmentUploadOperation,
  sanitizeAttachmentOperation
} from '../src/services/sync/attachment-operation.js';

const BASE = {
  orgId: 'org-1',
  direction: ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE,
  sourceAttachmentId: '42',
  localKey: 'LOCAL-1',
  remoteKey: 'REMOTE-1'
};

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('Persistent attachment operation ledger', () => {
  test('keys are scoped by organization, direction and source attachment ID', () => {
    expect(buildAttachmentOperationKey(BASE))
      .toBe('attachment-operation:org-1:local-to-remote:42');
    expect(buildAttachmentOperationKey({ ...BASE, direction: ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL }))
      .toBe('attachment-operation:org-1:remote-to-local:42');
    expect(buildAttachmentOperationKey({ ...BASE, orgId: 'org-2' }))
      .toBe('attachment-operation:org-2:local-to-remote:42');
  });

  test('first claim is atomic and records a unique attempt token', async () => {
    const first = await beginAttachmentUploadOperation(BASE);
    const second = await beginAttachmentUploadOperation(BASE);

    expect(first.allowed).toBe(true);
    expect(first.operation.attemptToken).toHaveLength(64);
    expect(second.allowed).toBe(false);
    expect(second.code).toBe(ATTACHMENT_OPERATION_CODES.IN_PROGRESS);
  });

  test('a pending upload with no write-start marker is retryable after grace', async () => {
    const startedAt = Date.now();
    const first = await beginAttachmentUploadOperation({ ...BASE, now: startedAt });
    expect(first.allowed).toBe(true);
    expect(first.operation.writeStartedAt).toBeUndefined();

    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: startedAt + 10 * 60 * 1000
    });

    expect(retry.allowed).toBe(true);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.RETRY_ALLOWED);
    expect(retry.operation.attempt).toBe(2);
    expect(retry.operation.writeStartedAt).toBeUndefined();
  });

  test('a write-start marker makes an unconfirmed upload reconciliation-only', async () => {
    const claim = await beginAttachmentUploadOperation(BASE);
    const marked = await markAttachmentWriteStarted(claim.operation);

    expect(marked.ok).toBe(true);
    expect(marked.operation.writeStartedAt).toBeTruthy();

    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: Date.now() + 60 * 60 * 1000
    });

    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED);
    expect(retry.operation.writeStartedAt).toBeTruthy();
  });

  test('an accepted upload without persisted success cannot issue another POST', async () => {
    const claim = await beginAttachmentUploadOperation(BASE);
    await markAttachmentSubmissionStarted(claim.operation);

    // This is the state left by invocation termination after Jira accepted the
    // POST but before markAttachmentUploadSucceeded persisted the destination.
    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: Date.now() + 24 * 60 * 60 * 1000
    });

    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED);
    expect(retry.operation.destinationAttachmentId).toBeUndefined();
  });


  test('an unknown upload is never retried automatically', async () => {

    const claim = await beginAttachmentUploadOperation(BASE);
    await markAttachmentSubmissionStarted(claim.operation);
    await markAttachmentUploadUnknown(claim.operation);

    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: Date.now() + 60 * 60 * 1000
    });

    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED);
  });

  test('a stale attempt cannot overwrite a newer attempt', async () => {
    const first = await beginAttachmentUploadOperation(BASE);
    await markAttachmentUploadFailedDefinitive(first.operation, {
      failureCode: 'ATTACHMENT_UPLOAD_REJECTED'
    });

    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: Date.now() + 10 * 60 * 1000
    });
    expect(retry.allowed).toBe(true);
    expect(retry.operation.attempt).toBe(2);

    const stale = await markAttachmentUploadSucceeded(first.operation, {
      destinationAttachmentId: '999'
    });
    expect(stale.success).toBe(false);
    expect(stale.code).toBe(ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT);

    const current = await getAttachmentOperation(BASE);
    expect(current.state).toBe(ATTACHMENT_OPERATION_STATES.PENDING);
    expect(current.destinationAttachmentId).toBeUndefined();

    const completed = await markAttachmentUploadSucceeded(retry.operation, {
      destinationAttachmentId: '1000'
    });
    expect(completed.success).toBe(true);
    expect((await getAttachmentOperation(BASE)).destinationAttachmentId).toBe('1000');
  });

  test('administrator resolution remains hidden from stale upload attempts', async () => {
    const claim = await beginAttachmentUploadOperation(BASE);
    await markAttachmentUploadUnknown(claim.operation);

    const resolution = await resolveAttachmentUploadOperation({
      operation: claim.operation,
      destinationAttachmentId: '1001'
    });
    expect(resolution.success).toBe(true);

    const lateAttempt = await markAttachmentUploadSucceeded(claim.operation, {
      destinationAttachmentId: '1002'
    });
    expect(lateAttempt.success).toBe(false);
    expect((await getAttachmentOperation(BASE)).destinationAttachmentId).toBe('1001');

    const safe = sanitizeAttachmentOperation(await getAttachmentOperation(BASE));
    expect(safe).not.toHaveProperty('attemptToken');
    expect(JSON.stringify(safe)).not.toContain('Basic ');
  });

  test('a stale upload attempt cannot write the write-start marker', async () => {
    const first = await beginAttachmentUploadOperation(BASE);
    await markAttachmentUploadFailedDefinitive(first.operation, {
      failureCode: 'ATTACHMENT_UPLOAD_REJECTED'
    });

    const retry = await beginAttachmentUploadOperation({
      ...BASE,
      now: Date.now() + 10 * 60 * 1000
    });
    expect(retry.allowed).toBe(true);
    expect(retry.operation.attempt).toBe(2);

    const stale = await markAttachmentWriteStarted(first.operation);
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe(ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT);

    const current = await getAttachmentOperation(BASE);
    expect(current.attempt).toBe(2);
    expect(current.writeStartedAt).toBeUndefined();
    expect(current.submissionStartedAt).toBeUndefined();
  });

  test('a pending deletion with no write-start marker is retryable after grace', async () => {
    const startedAt = Date.now();
    const claim = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84',
      now: startedAt
    });
    expect(claim.allowed).toBe(true);
    expect(claim.operation.writeStartedAt).toBeUndefined();

    const retry = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84',
      now: startedAt + 10 * 60 * 1000
    });

    expect(retry.allowed).toBe(true);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.RETRY_ALLOWED);
    expect(retry.operation.attempt).toBe(2);
  });

  test('a deletion write-start without a recorded result is never retried automatically', async () => {
    const claim = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84'
    });
    expect(claim.allowed).toBe(true);
    const marked = await markAttachmentDeletionSubmissionStarted(claim.operation);
    expect(marked.ok).toBe(true);
    expect(marked.operation.writeStartedAt).toBeTruthy();

    const retry = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84',
      now: Date.now() + 60 * 60 * 1000
    });

    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED);
    expect(retry.operation.writeStartedAt).toBeTruthy();
  });

  test('a stale deletion attempt cannot change a newer deletion operation', async () => {
    const first = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84'
    });
    await markAttachmentDeletionFailedDefinitive(first.operation, {
      failureCode: 'ATTACHMENT_DELETE_REJECTED'
    });

    const retry = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84',
      now: Date.now() + 10 * 60 * 1000
    });
    expect(retry.allowed).toBe(true);
    expect(retry.operation.attempt).toBe(2);

    const stale = await markAttachmentDeletionSubmissionStarted(first.operation);
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe(ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT);

    const current = await getAttachmentOperation({
      ...BASE,
      operationType: 'deletion'
    });
    expect(current.attempt).toBe(2);
    expect(current.writeStartedAt).toBeUndefined();
  });

  test('an ambiguous deletion is not retried automatically', async () => {
    const claim = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84'
    });
    expect(claim.allowed).toBe(true);
    await markAttachmentDeletionUnknown(claim.operation);

    const retry = await beginAttachmentDeletionOperation({
      ...BASE,
      mappedDestinationAttachmentId: '84',
      now: Date.now() + 60 * 60 * 1000
    });
    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED);
  });
});
