import { token } from '@atlaskit/tokens';
export const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  boxShadow: 'none',
  padding: token('space.200', '16px'),
  ...overrides
});

export const lozengeButtonStyle = {
  borderRadius: token('border.radius', '4px'),
  border: `1px solid ${token('color.border.brand', '#4C9AFF')}`,
  background: token('color.background.neutral', '#FFFFFF'),
  color: token('color.text', '#172B4D'),
  textTransform: 'none',
  letterSpacing: 'normal',
  fontSize: '12px',
  fontWeight: 500,
  padding: `0 ${token('space.150', '12px')}`,
  height: '28px',
  lineHeight: '26px',
  boxShadow: 'none'
};

export const formatDateTimeEuro = (timestamp, options = {}) => {
  if (!timestamp) return 'Not available';
  try {
    return new Intl.DateTimeFormat('fi-FI', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      ...options
    }).format(new Date(timestamp));
  } catch (error) {
    return new Date(timestamp).toLocaleString('fi-FI', { hour12: false, ...options });
  }
};

export const isLegacyScheduledActive = (config) => Boolean(
  config
  && config.enabled === true
  && ['recent', 'all'].includes(config.syncScope)
);

export const ISSUE_EXPORT_LIMIT = 250;
