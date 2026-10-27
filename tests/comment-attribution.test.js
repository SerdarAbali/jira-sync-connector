import {
  buildSyncedCommentADF,
  commentAuthorDisplayName,
  commentAuthorName,
  commentBodyContent,
  extractTextFromADF,
  stripSyncPrefix
} from '../src/utils/adf.js';

const boldBody = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Important ', marks: [{ type: 'strong' }] },
        { type: 'text', text: 'original content', marks: [{ type: 'em' }] }
      ]
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }
      ]
    }
  ]
};

describe('comment attribution and reply context', () => {
  test('uses only a safe display name and never an email fallback', () => {
    expect(commentAuthorName({ displayName: 'Ada Lovelace' })).toBe('Ada Lovelace');
    expect(commentAuthorName({ displayName: '  ' })).toBe('Unknown User');
    expect(commentAuthorName({ displayName: 'private@example.invalid' })).toBe('Unknown User');
    expect(commentAuthorName({ emailAddress: 'private@example.invalid' })).toBe('Unknown User');
    expect(commentAuthorName({ accountId: 'secret-account' })).toBe('Unknown User');
    expect(commentAuthorDisplayName({ emailAddress: 'private@example.invalid' })).toBeNull();
  });

  test('keeps formatting and never duplicates an existing attribution header', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      responseText: 'ignored when responseBody is supplied',
      responseBody: boldBody
    });
    expect(body.content[0].content[0].text).toBe('[Comment from Remote Org - User: Ada Lovelace]:');
    expect(body.content[1]).toEqual(boldBody.content[0]);
    expect(body.content[2]).toEqual(boldBody.content[1]);
    expect(extractTextFromADF(body)).toContain('Important original content');
    expect(extractTextFromADF(body)).toContain('first');
    expect(extractTextFromADF(body)).not.toContain('private@example.invalid');
  });

  test('renders a restrained reply context only when a parent was verified', () => {
    const withAuthor = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      parentAuthor: 'Grace Hopper',
      parentSnippet: 'Earlier decision',
      responseText: 'Agreed'
    });
    expect(withAuthor.content[1].content[0].text)
      .toBe('Replying to Grace Hopper: "Earlier decision"');
    expect(withAuthor.content[2].type).toBe('rule');

    const withoutAuthor = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      parentAuthor: null,
      parentSnippet: 'Earlier decision',
      responseText: 'Agreed'
    });
    expect(withoutAuthor.content[1].content[0].text)
      .toBe('Replying to earlier comment: "Earlier decision"');
  });

  test('does not expose email addresses from a parent author', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      parentAuthor: null,
      parentSnippet: 'Parent text',
      responseText: 'Agreed'
    });
    expect(JSON.stringify(body)).not.toContain('@');
    expect(JSON.stringify(body)).not.toContain('accountId');
  });

  test('keeps formatting while removing media and account-bearing mentions', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      responseText: 'fallback',
      responseBody: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: 'account-secret', text: '@Ada' } },
            { type: 'text', text: ' see ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.invalid' } }] },
            { type: 'mediaInline', attrs: { id: 'media-secret', collection: 'private' } }
          ]
        }]
      }
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('account-secret');
    expect(serialized).not.toContain('media-secret');
    expect(serialized).toContain('@Ada');
    expect(serialized).toContain('https://example.invalid');
    expect(serialized).toContain('"type":"strong"');
  });

  test('does not re-add an attribution header already present in ADF', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Ada Lovelace',
      responseBody: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '[Comment from Other Org - User: Grace]:' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Original body', marks: [{ type: 'strong' }] }] }
        ]
      }
    });
    const text = extractTextFromADF(body);
    expect(text.match(/\[Comment from /g)).toHaveLength(1);
    expect(text).toContain('Original body');
    expect(body.content[1].content[0].marks).toEqual([{ type: 'strong' }]);
  });

  test('strips one connector header and preserves user content when re-reading', () => {
    const text = '[Comment from Remote Org - User: Ada Lovelace]:\n\nOriginal body';
    expect(stripSyncPrefix(text)).toBe('Original body');
    expect(stripSyncPrefix('  leading user spacing')).toBe('  leading user spacing');
    expect(commentBodyContent(boldBody)).toEqual(boldBody.content);
  });

  test('invalid or absent ADF falls back to plain response text safely', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Remote Org',
      userName: 'Unknown User',
      responseText: 'Plain text',
      responseBody: { malformed: true }
    });
    expect(body.content[1].content[0].text).toBe('Plain text');
    expect(JSON.stringify(body)).not.toContain('private@example.invalid');
  });
});
