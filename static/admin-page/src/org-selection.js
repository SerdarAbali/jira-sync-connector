// Organization selection for the administration page.
//
// A selection is never inferred from list order: the page only uses an
// explicitly chosen organization or one restored from storage. A stale stored
// identifier resolves to "no selection" so configuration writes cannot target
// a different vendor organization after navigation or deletion.

export const SELECTED_ORGANIZATION_STORAGE_KEY = 'jiraSyncConnector.admin.selectedOrganizationId';

function defaultStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Returns the candidate identifier only when it matches a loaded organization.
 * Otherwise returns null and the page requires an explicit selection.
 */
export function resolveSelectedOrganizationId(organizations, candidateId) {
  if (typeof candidateId !== 'string' || candidateId === '') return null;
  if (!Array.isArray(organizations)) return null;
  return organizations.some(organization => organization?.id === candidateId)
    ? candidateId
    : null;
}

export function readStoredOrganizationId(storage = defaultStorage()) {
  try {
    const stored = storage?.getItem(SELECTED_ORGANIZATION_STORAGE_KEY);
    return typeof stored === 'string' && stored !== '' ? stored : null;
  } catch {
    return null;
  }
}

export function storeSelectedOrganizationId(organizationId, storage = defaultStorage()) {
  try {
    if (typeof organizationId === 'string' && organizationId !== '') {
      storage?.setItem(SELECTED_ORGANIZATION_STORAGE_KEY, organizationId);
    } else {
      storage?.removeItem(SELECTED_ORGANIZATION_STORAGE_KEY);
    }
  } catch {
    // Persistence is a convenience; unavailable storage must not block editing.
  }
}
