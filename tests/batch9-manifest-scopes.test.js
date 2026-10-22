const fs = require('fs');
const path = require('path');

const manifest = fs.readFileSync(path.join(__dirname, '..', 'manifest.yml'), 'utf8');

function manifestScopes() {
  const lines = manifest.split(/\r?\n/);
  const scopes = [];
  let inScopes = false;

  for (const line of lines) {
    if (line === '  scopes:') {
      inScopes = true;
      continue;
    }
    if (inScopes && /^  \S/.test(line)) {
      break;
    }
    if (inScopes) {
      const match = line.match(/^    - (\S+)$/);
      if (match) {
        scopes.push(match[1]);
      }
    }
  }

  return scopes;
}

describe('Batch 9 manifest scope allowlist', () => {
  test('only the approved scopes remain, with read:issue-link:jira removed', () => {
    expect(manifestScopes()).toEqual([
      'storage:app',
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'read:comment:jira',
      'write:comment:jira',
      'write:issue-link:jira',
      'read:issue-meta:jira',
      'read:project:jira'
    ]);
    expect(manifestScopes()).not.toContain('read:issue-link:jira');
  });

  test('broad permissions are documented as temporary pilot scopes', () => {
    expect(manifest).toContain('Temporary broad scopes retained for the corporate pilot');
    expect(manifest).toContain('write:jira-work still covers issue deletion');
    expect(manifest).toContain('read:jira-user still supplies account data');
    expect(manifest).toContain('A granular migration is a separate, live-tested change');
  });
});
