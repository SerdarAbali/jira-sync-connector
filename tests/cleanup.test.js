import { cleanupIssueData } from '../src/services/storage/cleanup.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import * as mappings from '../src/services/storage/mappings.js';
import * as flags from '../src/services/storage/flags.js';

// Mock dependencies
jest.mock('../src/services/storage/kvs.js');
jest.mock('../src/services/storage/mappings.js');
jest.mock('../src/services/storage/flags.js');

describe('Cleanup Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cleanupIssueData should call all removal functions', async () => {
    const issueKey = 'TEST-1';
    const remoteKey = 'REMOTE-1';
    const orgId = 'org-1';

    await cleanupIssueData(issueKey, remoteKey, orgId);

    // Verify mappings removal
    expect(mappings.removeMapping).toHaveBeenCalledWith(issueKey, remoteKey, orgId);

    // Verify pending links removal
    expect(kvsStore.del).toHaveBeenCalledWith(`pending-links:${issueKey}`);
    expect(flags.removeIssueFromPendingLinksIndex).toHaveBeenCalledWith(issueKey);

    // Verify timestamp removal
    expect(kvsStore.del).toHaveBeenCalledWith(`created-timestamp:${issueKey}`);

    // Verify syncing flag removal
    expect(kvsStore.del).toHaveBeenCalledWith(`syncing:${issueKey}`);
  });

  test('cleanupIssueData should handle errors gracefully', async () => {
    mappings.removeMapping.mockRejectedValue(new Error('Storage error'));
    
    // Should not throw
    await expect(cleanupIssueData('TEST-1', 'REMOTE-1')).resolves.not.toThrow();
  });
});
