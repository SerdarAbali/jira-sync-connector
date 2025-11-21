export function mapUserToRemote(localAccountId, userMappings) {
  if (!localAccountId) return null;
  
  for (const [remoteId, mapping] of Object.entries(userMappings)) {
    const localId = typeof mapping === 'string' ? mapping : mapping.localId;
    if (localId === localAccountId) {
      return remoteId;
    }
  }
  
  return null;
}

export function reverseMapping(mapping) {
  const reversed = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value) {
      const localId = typeof value === 'string' ? value : value.localId;
      if (localId) {
        reversed[localId] = key;
      }
    }
  }
  return reversed;
}
