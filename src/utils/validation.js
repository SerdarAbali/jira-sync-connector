// Input validation utilities

/**
 * Validates that required fields are present and non-empty
 */
export function validateRequired(payload, fields) {
  const errors = [];
  for (const field of fields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join(', '));
  }
}

/**
 * Validates that a value is a non-empty string
 */
export function validateString(value, fieldName, maxLength = 1000) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  return value.trim();
}

/**
 * Validates that a value is a valid URL
 */
export function validateUrl(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`${fieldName} must use http or https protocol`);
    }
    return value.trim();
  } catch (e) {
    throw new Error(`${fieldName} is not a valid URL`);
  }
}

/**
 * Validates that a value is a valid email
 */
export function validateEmail(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(value)) {
    throw new Error(`${fieldName} is not a valid email address`);
  }
  return value.trim();
}

/**
 * Validates that a value is a plain object
 */
export function validateObject(value, fieldName) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

/**
 * Validates that a value is an array
 */
export function validateArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

/**
 * Validates organization payload
 */
export function validateOrganizationPayload(payload) {
  validateRequired(payload, ['name', 'remoteUrl', 'remoteEmail', 'remoteProjectKey']);
  
  return {
    name: validateString(payload.name, 'name', 100),
    remoteUrl: validateUrl(payload.remoteUrl, 'remoteUrl'),
    remoteEmail: validateEmail(payload.remoteEmail, 'remoteEmail'),
    remoteApiToken: payload.remoteApiToken ? validateString(payload.remoteApiToken, 'remoteApiToken', 500) : undefined,
    remoteProjectKey: validateString(payload.remoteProjectKey, 'remoteProjectKey', 20),
    allowedProjects: payload.allowedProjects ? validateArray(payload.allowedProjects, 'allowedProjects') : []
  };
}

/**
 * Validates org ID format
 */
export function validateOrgId(orgId) {
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('Invalid organization ID');
  }
  if (!/^org-\d+$/.test(orgId)) {
    throw new Error('Invalid organization ID format');
  }
  return orgId;
}

/**
 * Validates mappings object (key-value pairs)
 */
export function validateMappings(mappings, fieldName) {
  validateObject(mappings, fieldName);
  // Limit number of mappings to prevent abuse
  const keys = Object.keys(mappings);
  if (keys.length > 500) {
    throw new Error(`${fieldName} exceeds maximum of 500 entries`);
  }
  return mappings;
}

export async function isProjectAllowedToSync(projectKey, config) {
  // If no filter is configured, allow all projects (backward compatibility)
  if (!config.allowedProjects || !Array.isArray(config.allowedProjects) || config.allowedProjects.length === 0) {
    console.log(`✅ No project filter configured - allowing ${projectKey}`);
    return true;
  }

  // Check if project is in allowed list
  const isAllowed = config.allowedProjects.includes(projectKey);

  if (isAllowed) {
    console.log(`✅ Project ${projectKey} is in allowed list`);
  } else {
    console.log(`⛔ Project ${projectKey} is NOT in allowed list [${config.allowedProjects.join(', ')}] - skipping sync`);
  }

  return isAllowed;
}
