export function extractTextFromADF(adf) {
  if (!adf || typeof adf !== 'object') return '';
  
  let text = '';
  
  function traverse(node, isFirstNode = false) {
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

export function extractSprintIds(fieldValue) {
  if (!fieldValue) {
    return null;
  }

  // Sprint fields are ALWAYS arrays - if it's not an array, it's not a sprint field
  if (!Array.isArray(fieldValue)) {
    return null;
  }

  if (fieldValue.length === 0) {
    return null;
  }

  // Check if this is sprint data (array of objects with id, name, state properties)
  if (typeof fieldValue[0] === 'object' && fieldValue[0] !== null) {
    // Sprint objects have specific properties like id, name, state, goal
    // If it has an 'id' property, it's likely a sprint object
    if (fieldValue[0].id === undefined) {
      return null;
    }

    const ids = fieldValue
      .map(item => {
        // Sprint objects can have id as number or string
        if (typeof item.id === 'number') return item.id;
        if (typeof item.id === 'string') {
          const parsed = parseInt(item.id, 10);
          return isNaN(parsed) ? null : parsed;
        }
        return null;
      })
      .filter(id => id !== null);

    return ids.length > 0 ? ids : null;
  }

  // Already an array of numbers - could be sprint IDs
  if (typeof fieldValue[0] === 'number') {
    return fieldValue;
  }

  // Array of strings that might be sprint IDs
  if (typeof fieldValue[0] === 'string') {
    const ids = fieldValue
      .map(val => {
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? null : parsed;
      })
      .filter(id => id !== null);
    return ids.length > 0 ? ids : null;
  }

  return null;
}
