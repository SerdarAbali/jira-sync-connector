import {
  buildSyncedCommentADF,
  commentBodyContent,
  extractTextFromADF
} from '../src/utils/adf.js';

const realisticBody = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '[Comment from Original Org - User: Original User]:\n\nActual first paragraph '
        },
        { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        { type: 'text', text: ' and ' },
        {
          type: 'text',
          text: 'the docs',
          marks: [{
            type: 'link',
            attrs: {
              href: 'https://example.invalid/docs?lang=en',
              title: 'unnecessary title',
              accountId: 'link-account-secret'
            }
          }]
        },
        { type: 'text', text: ' but not ' },
        {
          type: 'text',
          text: 'this unsafe link',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', accountId: 'unsafe-link' } }]
        }
      ]
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Line one' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Line two — café ✓ 日本語' }
      ]
    },
    {
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] }
      ]
    },
    {
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [{ type: 'text', text: 'const answer = "✓";' }]
    },
    {
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Outer bullet' }] },
          {
            type: 'orderedList',
            attrs: { order: 1 },
            content: [{
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested number' }] }]
            }]
          }
        ]
      }]
    },
    {
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: 'account-secret', text: '@Ada Lovelace', accessLevel: '' } },
        { type: 'text', text: ' and ' },
        { type: 'mention', attrs: { id: 'email-secret', text: '@private@example.invalid' } },
        { type: 'mention', attrs: { id: 'account-text-secret', text: '@[~accountid:account-text-secret]' } }
      ]
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Before unsupported ' },
        { type: 'mediaInline', attrs: { id: 'media-secret', collection: 'private' } },
        { type: 'inlineCard', attrs: { url: 'https://private.invalid/card' } },
        { type: 'extension', attrs: { extensionKey: 'private-extension' } },
        { type: 'text', text: 'After unsupported' }
      ]
    }
  ]
};

function allNodes(node, types = []) {
  if (Array.isArray(node)) {
    node.forEach(child => allNodes(child, types));
    return types;
  }
  if (!node || typeof node !== 'object') return types;
  types.push(node);
  if (Array.isArray(node.content)) node.content.forEach(child => allNodes(child, types));
  return types;
}

describe('realistic comment ADF fidelity', () => {
  test('preserves supported formatting, links, lists, quotes, code and Unicode', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Target Org',
      userName: 'Target User',
      responseBody: realisticBody
    });
    const nodes = allNodes(body);
    const types = nodes.map(node => node.type);
    expect(types).toEqual(expect.arrayContaining([
      'paragraph', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'hardBreak'
    ]));
    expect(nodes.find(node => node.type === 'codeBlock')).toEqual({
      type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const answer = "✓";' }]
    });
    expect(extractTextFromADF(body)).toContain('Actual first paragraph bold and italic and code');
    expect(extractTextFromADF(body)).toContain('Line one');
    expect(extractTextFromADF(body)).toContain('Line two — café ✓ 日本語');
    expect(extractTextFromADF(body)).toContain('Quoted text');
    expect(extractTextFromADF(body)).toContain('Outer bullet');
    expect(extractTextFromADF(body)).toContain('Nested number');
    expect(extractTextFromADF(body)).toContain('the docs');
  });

  test('keeps valid link destinations while removing unsafe link metadata and schemes', () => {
    const body = buildSyncedCommentADF({ orgName: 'Target Org', userName: 'Target User', responseBody: realisticBody });
    const serialized = JSON.stringify(body);
    const link = allNodes(body).find(node => node.marks?.some(mark => mark.type === 'link'));
    expect(link.marks).toEqual([{ type: 'link', attrs: { href: 'https://example.invalid/docs?lang=en' } }]);
    expect(serialized).not.toContain('link-account-secret');
    expect(serialized).not.toContain('unnecessary title');
    expect(serialized).not.toContain('javascript:alert');
    expect(serialized).not.toContain('unsafe-link');
    expect(serialized).toContain('this unsafe link');
  });


  test('strips a generated header without leaving a stray hard break', () => {
    const body = buildSyncedCommentADF({
      orgName: 'Target Org',
      userName: 'Target User',
      responseBody: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: '[Comment from Original Org - User: Original User]:' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Legitimate body' }
          ]
        }]
      }
    });
    expect(body.content[1]).toEqual({
      type: 'paragraph', content: [{ type: 'text', text: 'Legitimate body' }]
    });
  });


  test('sanitizes mentions and unsupported nodes without losing surrounding text', () => {
    const body = buildSyncedCommentADF({ orgName: 'Target Org', userName: 'Target User', responseBody: realisticBody });
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('"text":"@Ada Lovelace"');
    expect(serialized).not.toContain('account-secret');
    expect(serialized).not.toContain('email-secret');
    expect(serialized).not.toContain('account-text-secret');
    expect(serialized).not.toContain('private@example.invalid');
    expect(serialized).not.toContain('"type":"mediaInline"');
    expect(serialized).not.toContain('"type":"inlineCard"');
    expect(serialized).not.toContain('"type":"extension"');
    expect(serialized).toContain('Before unsupported');
    expect(serialized).toContain('After unsupported');
  });

  test('strips exactly one generated attribution header and preserves the original body', () => {
    const body = buildSyncedCommentADF({ orgName: 'Target Org', userName: 'Target User', responseBody: realisticBody });
    const text = extractTextFromADF(body);
    expect(text.match(/\[Comment from /g)).toHaveLength(1);
    expect(text.startsWith('[Comment from Target Org - User: Target User]:')).toBe(true);
    expect(text).toContain('Actual first paragraph');
    const content = commentBodyContent(realisticBody);
    expect(content[0].content.some(node => node.text?.includes('Actual first paragraph'))).toBe(true);
  });
});
