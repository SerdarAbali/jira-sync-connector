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
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: fullText
          }
        ]
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

export function prependCrossReferenceToADF(adf, localKey, remoteKey, localOrgName, remoteOrgName) {
  // Create a minimal cross-reference line
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

  // If adf has no content or is empty, create new doc with just the reference
  if (!adf || !adf.content || adf.content.length === 0) {
    return {
      type: 'doc',
      version: 1,
      content: [crossRefLine]
    };
  }

  // Check if the first element is already our cross-reference (to avoid duplicates on updates)
  const firstContent = adf.content[0];
  if (firstContent && 
      firstContent.type === 'paragraph' &&
      firstContent.content?.[0]?.text?.startsWith('🔗 ') &&
      firstContent.content?.[0]?.text?.includes(' ↔ ')) {
    // Replace existing cross-reference with updated one
    return {
      ...adf,
      content: [crossRefLine, ...adf.content.slice(1)]
    };
  }

  // Prepend the cross-reference line to existing content
  return {
    ...adf,
    content: [crossRefLine, ...adf.content]
  };
}


