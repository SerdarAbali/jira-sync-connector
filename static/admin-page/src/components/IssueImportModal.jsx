import React from 'react';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Checkbox from '@atlaskit/checkbox';
import ModalDialog, { ModalHeader, ModalTitle, ModalBody } from '@atlaskit/modal-dialog';
import { token } from '@atlaskit/tokens';
import { lozengeButtonStyle, formatDateTimeEuro } from '../dashboard/presentation';
const IssueImportModal = ({ data, options, onOptionChange, onConfirm, onClose, importing, selectedOrg }) => {
  const meta = data?.meta || {};
  const disabled = importing;

  return (
    <ModalDialog onClose={onClose} width="medium">
      <ModalHeader>
        <ModalTitle>Import Issues</ModalTitle>
      </ModalHeader>
      <ModalBody>
      <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') }}>
        <div style={{ fontSize: '13px', color: '#6B778C' }}>
          <div><strong>Destination:</strong> {selectedOrg?.name || 'Selected organization'}</div>
          <div><strong>Issues detected:</strong> {data.issueKeys.length}</div>
          {meta.sourceOrg && <div><strong>Source org:</strong> {meta.sourceOrg}</div>}
          {meta.query && <div><strong>Original JQL:</strong> {meta.query}</div>}
          {meta.exportedAt && <div><strong>Exported:</strong> {formatDateTimeEuro(meta.exportedAt)}</div>}
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px 0' }}>Import options</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            <Checkbox
              label="Fetch latest data from source Jira (recommended)"
              isChecked={options.refreshFromSource}
              onChange={(event) => onOptionChange('refreshFromSource', event.target.checked)}
              isDisabled={disabled}
            />
            <SectionMessage appearance="info">
              <p style={{ margin: 0, fontSize: '13px' }}>
                Force re-create is disabled. Imports never delete mappings or create replacement issues.
              </p>
            </SectionMessage>
            <Checkbox
              label="Skip issues that already have a remote copy"
              isChecked={options.skipIfRemoteExists}
              onChange={(event) => onOptionChange('skipIfRemoteExists', event.target.checked)}
              isDisabled={disabled}
            />
          </div>
        </div>
        {!options.refreshFromSource && (
          <SectionMessage appearance="warning">
            <p style={{ margin: 0, fontSize: '13px' }}>
              Importing from the export snapshot may fail if attachments or comments reference resources that no longer exist. Keep this option enabled when the source Jira is still accessible.
            </p>
          </SectionMessage>
        )}
        {options.refreshFromSource && (
          <SectionMessage appearance="info">
            <p style={{ margin: 0, fontSize: '13px' }}>
              The app will re-fetch each issue before importing so attachments and latest field values are included. Ensure the source issues still exist.
            </p>
          </SectionMessage>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: token('space.150', '12px') }}>
          <Button
            appearance="subtle"
            onClick={onConfirm}
            isLoading={importing}
            style={lozengeButtonStyle}
          >
            Import Issues
          </Button>
          <Button appearance="subtle" onClick={onClose} isDisabled={importing} style={lozengeButtonStyle}>
            Cancel
          </Button>
        </div>
      </div>
      </ModalBody>
    </ModalDialog>
  );
};

export default IssueImportModal;
