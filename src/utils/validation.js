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
