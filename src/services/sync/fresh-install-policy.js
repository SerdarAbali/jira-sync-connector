// Explicit engineering policy for one entirely disposable staging installation.
// Historical provenance is waived only here; no platform-history claim is made.
export const FRESH_INITIALIZATION_POLICY = 'disposable-staging-v1';
export const FRESH_INSTALLATION_TARGET = Object.freeze({
  appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
  environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
  installationId: '974910c5-2861-4d40-a7eb-37802842d0a0',
  siteHost: 'serdarjiraone.atlassian.net'
});

export function matchesFreshInstallationContext(context) {
  const target = FRESH_INSTALLATION_TARGET;
  return context?.appAri?.appId === target.appId
    && context?.environmentAri?.environmentId === target.environmentId
    && context?.installationAri?.installationId === target.installationId
    && typeof context?.environmentType === 'string'
    && context.environmentType.toUpperCase() === 'STAGING'
    && (!Object.prototype.hasOwnProperty.call(context.appAri, 'toString')
      || context.appAri.toString() === `ari:cloud:ecosystem::app/${target.appId}`);
}
