import React from 'react';
import Button from '@atlaskit/button';

import SectionMessage from '@atlaskit/section-message';
import Checkbox from '@atlaskit/checkbox';
import ModalDialog, { ModalHeader, ModalTitle, ModalBody } from '@atlaskit/modal-dialog';
import { token } from '@atlaskit/tokens';
import { lozengeButtonStyle, formatDateTimeEuro } from '../dashboard/presentation';
const ImportSettingsModal = ({ importData, sections, onToggleSection, onConfirm, onClose, importing }) => {
  const sectionOptions = [
    { key: 'orgDetails', label: 'Connection details & project filters' },
    { key: 'syncOptions', label: 'Sync options' },
    { key: 'userMappings', label: 'User mappings' },
    { key: 'fieldMappings', label: 'Field mappings' },
    { key: 'statusMappings', label: 'Status mappings' },
    { key: 'scheduledSync', label: 'Legacy scheduled synchronization configuration (global)' }
  ];
  const hasSelection = sectionOptions.some(option => sections?.[option.key]);

  return (
    <ModalDialog onClose={onClose} width="medium">
      <ModalHeader>
        <ModalTitle>Import Settings</ModalTitle>
      </ModalHeader>
      <ModalBody>
      <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') }}>
        <div style={{ fontSize: '13px', color: '#6B778C' }}>
          <div><strong>Source org:</strong> {importData?.org?.name || 'Unknown organization'}</div>
          <div><strong>Exported:</strong> {importData?.exportedAt ? formatDateTimeEuro(importData.exportedAt) : 'Not specified'}</div>
          {importData?.version && (
            <div><strong>Schema version:</strong> {importData.version}</div>
          )}
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px 0' }}>Select sections to import</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            {sectionOptions.map(option => (
              <Checkbox
                key={option.key}
                label={option.label}
                name={`import-${option.key}`}
                isChecked={!!sections?.[option.key]}
                onChange={() => onToggleSection(option.key)}
              />
            ))}
          </div>
        </div>
        <SectionMessage appearance="warning">
          <p style={{ margin: 0, fontSize: '13px' }}>
            Importing will overwrite the selected sections for the currently active organization. This action cannot be undone.
          </p>
        </SectionMessage>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: token('space.150', '12px') }}>
          <Button
            appearance="subtle"
            onClick={onConfirm}
            isDisabled={!hasSelection}
            isLoading={importing}
            style={lozengeButtonStyle}
          >
            Import Selected
          </Button>
          <Button appearance="subtle" onClick={onClose} style={lozengeButtonStyle}>
            Cancel
          </Button>
        </div>
      </div>
      </ModalBody>
    </ModalDialog>
  );
};

export default ImportSettingsModal;
