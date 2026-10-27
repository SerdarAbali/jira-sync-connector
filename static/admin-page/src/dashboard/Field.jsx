import React from 'react';
import { token } from '@atlaskit/tokens';

/** Shared label/value pair used by the recovery, security and adoption cards. */
export const fieldLabelStyle = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: token('color.text.subtle', '#6B778C')
};

export default function Field({ label, value }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ fontSize: '13px' }}>{value}</div>
    </div>
  );
}
