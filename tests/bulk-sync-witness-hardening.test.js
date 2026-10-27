import fs from 'fs';
import path from 'path';
import { run } from '../src/triggers/bulk-sync.js';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/triggers/bulk-sync.js'),
  'utf8'
);

describe('bulk-sync witness hardening', () => {
  test('the production handler remains disabled and performs no Jira work', async () => {
    const result = await run();

    expect(result).toMatchObject({
      success: false,
      code: 'BULK_SYNC_CONSUMER_DISABLED'
    });
  });

  test('a summary match is reported, never converted into a mapping', () => {
    expect(source).toContain('bulk-summary-match-unverified');
    expect(source).not.toMatch(/storeMapping\s*\(/);
    expect(source).not.toMatch(/removeMapping\s*\(/);
  });

  test('a 404 requires the recovery workflow instead of recreating', () => {
    expect(source).toContain('bulk-deleted-counterpart-requires-recovery');
    expect(source).toContain('totalUnverifiedMatches');
  });

  test('bulk sync no longer imports mapping writers', () => {
    expect(source).toMatch(/import \{ getRemoteKey \} from '\.\.\/services\/storage\/mappings\.js';/);
    expect(source).not.toContain('storeMapping,');
    expect(source).not.toContain('removeMapping');
  });
});
