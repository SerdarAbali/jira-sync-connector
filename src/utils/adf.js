export function extractTextFromADF(adf, skipCrossReference = true) {
  if (!adf || typeof adf !== 'object') return '';
  
  let text = '';
  
  function traverse(node, isFirstNode = false) {
    // Skip cross-reference line if requested (old panel format or new minimal format)
    if (skipCrossReference) {
      // Old panel format
      if (node.type === 'panel' && 
          node.attrs?.panelType === 'info' &&
          node.content?.[0]?.content?.[0]?.text === '🔗 Synced Issue Reference') {
        return;
      }
      // New minimal format - paragraph starting with 🔗 and containing ↔
      if (node.type === 'paragraph' &&
          node.content?.[0]?.text?.startsWith('🔗 ') &&
          node.content?.[0]?.text?.includes(' ↔ ')) {
        return;
      }
      // Skip rule dividers that follow cross-reference
      if (node.type === 'rule') {
        return;
      }
    }
    
    if (node.type === 'text') {
      text += node.text;
    } else if (node.type === 'paragraph' && !isFirstNode && text.length > 0) {
      // Add line breaks between paragraphs
      text += '\n\n';
    } else if (node.type === 'hardBreak') {
      text += '\n';
    }
    
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child, index) => traverse(child, index === 0 && isFirstNode));
    }
  }
  
  traverse(adf, true);
  return text.trim();
}

export async function replaceMediaIdsInADF(adf, attachmentMapping) {
  if (!adf || typeof adf !== 'object') return adf;
  
  // Deep clone to avoid mutating original
  const cloned = JSON.parse(JSON.stringify(adf));
  
  function traverse(node) {
    if (node.type === 'media' && node.attrs && node.attrs.id) {
      const localId = node.attrs.id;
      const remoteId = attachmentMapping[localId];
      if (remoteId) {
        console.log(`🖼️ Replacing media ID: ${localId} → ${remoteId}`);
        node.attrs.id = remoteId;
      } else {
        console.log(`⚠️ No mapping found for media ID: ${localId}`);
      }
    }
    
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  }
  
  traverse(cloned);
  return cloned;
}

export function textToADFWithAuthor(text, orgName, userName) {
  const prefix = `[Comment from ${orgName} - User: ${userName}]:\n\n`;
  const fullText = prefix + (text || '');
  
  return {
    type: 'doc',
    version: 1,
    content: [
      buildParagraph(fullText)
    ]
  };
}

export function buildSyncedCommentADF({
  orgName,
  userName,
  parentAuthor,
  parentSnippet,
  responseText
}) {
  const header = `[Comment from ${orgName} - User: ${userName}]:`;
  const snippetText = parentSnippet ? `: "${parentSnippet}"` : '';
  const replyLine = parentAuthor
    ? `Replying to ${parentAuthor}${snippetText}`.trim()
    : parentSnippet
      ? `Replying to earlier comment${snippetText}`
      : '';

  const content = [buildParagraph(header)];

  if (replyLine) {
    content.push(buildParagraph(replyLine));
    content.push({ type: 'rule' });
  }

  content.push(buildParagraph(responseText || ''));

  return {
    type: 'doc',
    version: 1,
    content
  };
}

function buildParagraph(text) {
  if (!text) {
    return { type: 'paragraph', content: [] };
  }
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

export function textToADF(text) {
  if (!text || text.trim() === '') {
    return {
      type: 'doc',
      version: 1,
      content: []
    };
  }
  
  // Split by double line breaks for paragraphs
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  
  if (paragraphs.length === 0) {
    return {
      type: 'doc',
      version: 1,
      content: []
    };
  }
  
  const content = paragraphs.map(para => ({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: para.trim()
      }
    ]
  }));
  
  return {
    type: 'doc',
    version: 1,
    content: content
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidAdfNode(node) {
  if (!isPlainObject(node) || typeof node.type !== 'string' || !node.type) {
    return false;
  }
  if (node.content !== undefined && !Array.isArray(node.content)) {
    return false;
  }
  if (Array.isArray(node.content) && !node.content.every(isValidAdfNode)) {
    return false;
  }
  if (node.marks !== undefined && !Array.isArray(node.marks)) {
    return false;
  }
  if (node.type === 'text' && typeof node.text !== 'string') {
    return false;
  }
  return true;
}

export function isValidADFDocument(adf) {
  return isPlainObject(adf)
    && adf.type === 'doc'
    && (adf.version === undefined || adf.version === 1)
    && Array.isArray(adf.content)
    && adf.content.every(isValidAdfNode);
}

function cloneAdf(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDescriptionToAdf(description) {
  if (description === null || description === undefined) {
    return { type: 'doc', version: 1, content: [] };
  }
  if (typeof description === 'string') {
    return textToADF(description);
  }
  if (!isValidADFDocument(description)) {
    return null;
  }
  return cloneAdf(description);
}

function isCrossReferenceParagraph(node) {
  return isPlainObject(node)
    && node.type === 'paragraph'
    && Array.isArray(node.content)
    && node.content.length === 1
    && node.content[0]?.type === 'text'
    && typeof node.content[0]?.text === 'string'
    && /^🔗 .+ ↔ .+$/.test(node.content[0].text);
}

function contentWithoutCrossReference(adf) {
  return adf.content.filter(node => !isCrossReferenceParagraph(node));
}

/**
 * Return a new ADF document with exactly one cross-reference paragraph followed
 * by the original content. The input is never mutated.
 *
 * Returns null for malformed/unsupported descriptions so callers can preserve
 * the existing Jira description instead of writing an empty replacement.
 */
export function prependCrossReferenceToADF(adf, localKey, remoteKey) {
  const original = normalizeDescriptionToAdf(adf);
  if (!original) {
    return null;
  }

  const crossRefLine = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `🔗 ${localKey} ↔ ${remoteKey}`,
        marks: [{ type: 'em' }]
      }
    ]
  };

  return {
    ...original,
    content: [crossRefLine, ...contentWithoutCrossReference(original)]
  };
}

export function adfPreservesOriginalContent(originalDescription, resultAdf) {
  if (!isValidADFDocument(resultAdf)) {
    return false;
  }
  const original = normalizeDescriptionToAdf(originalDescription);
  if (!original) {
    return false;
  }
  const expectedContent = contentWithoutCrossReference(original);
  const resultContent = contentWithoutCrossReference(resultAdf);
  return JSON.stringify(expectedContent) === JSON.stringify(resultContent);
}


const SYNC_PREFIX_REGEX = /^\[Comment from [^\]]+\]:\s*/i;
const ACCOUNT_MENTION_REGEX = /\[~accountid:[^\]]+\]/gi;

export function stripSyncPrefix(text) {
  if (!text) {
    return '';
  }
  return text.replace(SYNC_PREFIX_REGEX, '').trimStart();
}

export function sanitizeCommentText(text) {
  if (!text) {
    return '';
  }

  let result = text.replace(ACCOUNT_MENTION_REGEX, '');
  result = result.replace(/[ \t]+\n/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/[ \t]{2,}/g, ' ');
  result = result.replace(/\n +/g, '\n');
  return result.trim();
}


