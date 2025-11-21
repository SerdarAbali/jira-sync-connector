import { storage } from '@forge/api';

export async function getRemoteKey(localKey) {
  return await storage.get(`local-to-remote:${localKey}`);
}

export async function getLocalKey(remoteKey) {
  return await storage.get(`remote-to-local:${remoteKey}`);
}

export async function storeMapping(localKey, remoteKey) {
  await storage.set(`local-to-remote:${localKey}`, remoteKey);
  await storage.set(`remote-to-local:${remoteKey}`, localKey);
}

export async function storeAttachmentMapping(localAttachmentId, remoteAttachmentId) {
  await storage.set(`attachment-mapping:${localAttachmentId}`, remoteAttachmentId);
}

export async function getAttachmentMapping(localAttachmentId) {
  return await storage.get(`attachment-mapping:${localAttachmentId}`);
}

export async function storeLinkMapping(localLinkId, remoteLinkId) {
  await storage.set(`link-mapping:${localLinkId}`, remoteLinkId);
}

export async function getLinkMapping(localLinkId) {
  return await storage.get(`link-mapping:${localLinkId}`);
}
