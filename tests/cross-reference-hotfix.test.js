import {
  adfPreservesOriginalContent,
  isValidADFDocument,
  prependCrossReferenceToADF
} from '../src/utils/adf.js';

function text(value, marks = []) {
  return marks.length > 0
    ? { type: 'text', text: value, marks }
    : { type: 'text', text: value };
}

function paragraph(value, marks = []) {
  return { type: 'paragraph', content: [text(value, marks)] };
}

function doc(...content) {
  return { type: 'doc', version: 1, content };
}

describe('Cross-reference ADF hotfix', () => {
  test('normal non-empty paragraph remains after prepend', () => {
    const original = doc(paragraph('Original description'));
    const result = prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');
    const combinedText = JSON.stringify(result);

    expect(combinedText).toContain('Original description');
    expect(combinedText).toContain('🔗 LOCAL-1 ↔ REMOTE-1');
    expect(adfPreservesOriginalContent(original, result)).toBe(true);
  });

  test('multiple paragraphs remain unchanged and in order', () => {
    const original = doc(paragraph('First'), paragraph('Second'), paragraph('Third'));
    const result = prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');

    expect(result.content.slice(1)).toEqual(original.content);
    expect(adfPreservesOriginalContent(original, result)).toBe(true);
  });

  test('rich marks remain unchanged', () => {
    const marks = [
      { type: 'strong' },
      { type: 'em' },
      { type: 'link', attrs: { href: 'https://example.invalid' } }
    ];
    const original = doc(paragraph('Rich text', marks));
    const result = prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');

    expect(result.content[1]).toEqual(original.content[0]);
    expect(result.content[1].content[0].marks).toEqual(marks);
    expect(adfPreservesOriginalContent(original, result)).toBe(true);
  });

  test('lists, links and nested ADF nodes are preserved', () => {
    const original = doc(
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph('List item with '),
              { type: 'paragraph', content: [text('link', [{ type: 'link', attrs: { href: 'https://example.invalid' } }])] }
            ]
          }
        ]
      },
      {
        type: 'panel',
        attrs: { panelType: 'info' },
        content: [paragraph('Nested panel')]
      }
    );

    const result = prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');

    expect(result.content.slice(1)).toEqual(original.content);
    expect(adfPreservesOriginalContent(original, result)).toBe(true);
  });

  test('input description is not mutated', () => {
    const original = doc(paragraph('Immutable text'));
    const before = JSON.parse(JSON.stringify(original));

    prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');

    expect(original).toEqual(before);
  });

  test('null description produces cross-reference-only ADF', () => {
    const result = prependCrossReferenceToADF(null, 'LOCAL-1', 'REMOTE-1');

    expect(isValidADFDocument(result)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].content[0].text).toBe('🔗 LOCAL-1 ↔ REMOTE-1');
  });

  test('empty ADF produces cross-reference-only ADF', () => {
    const result = prependCrossReferenceToADF(doc(), 'LOCAL-1', 'REMOTE-1');

    expect(isValidADFDocument(result)).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  test('malformed descriptions never produce an empty replacement', () => {
    for (const malformed of [
      { type: 'doc', version: 1, content: 'not-an-array' },
      { foo: 'bar' },
      { type: 'doc', content: [{ type: 'paragraph', content: 'bad' }] }
    ]) {
      expect(prependCrossReferenceToADF(malformed, 'LOCAL-1', 'REMOTE-1')).toBeNull();
    }
  });

  test('existing non-cross-reference content cannot be removed', () => {
    const original = doc(paragraph('Keep me'), paragraph('And me'));
    const result = prependCrossReferenceToADF(original, 'LOCAL-1', 'REMOTE-1');

    expect(adfPreservesOriginalContent(original, result)).toBe(true);
    expect(adfPreservesOriginalContent(original, { ...result, content: [result.content[0]] })).toBe(false);
  });

  test('the same cross-reference is not added twice', () => {
    const first = prependCrossReferenceToADF(doc(paragraph('Body')), 'LOCAL-1', 'REMOTE-1');
    const second = prependCrossReferenceToADF(first, 'LOCAL-1', 'REMOTE-1');
    const crossReferences = second.content.filter(node =>
      node.type === 'paragraph' && node.content?.[0]?.text?.startsWith('🔗 ')
    );

    expect(crossReferences).toHaveLength(1);
    expect(second.content[1]).toEqual(paragraph('Body'));
  });

  test('plain non-empty string descriptions are preserved as ADF', () => {
    const result = prependCrossReferenceToADF('Plain description', 'LOCAL-1', 'REMOTE-1');

    expect(JSON.stringify(result)).toContain('Plain description');
    expect(isValidADFDocument(result)).toBe(true);
  });
});
