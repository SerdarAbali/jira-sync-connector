import React, { useState } from 'react';
import Button from '@atlaskit/button';
import Form, { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import Select from '@atlaskit/select';
import SectionMessage from '@atlaskit/section-message';
import ModalDialog, { ModalHeader, ModalTitle, ModalBody } from '@atlaskit/modal-dialog';
import { token } from '@atlaskit/tokens';

// Org Modal Component
const OrgModal = ({ editingOrg, onClose, onSave, saving }) => {
  const [syncDirection, setSyncDirection] = useState(editingOrg?.syncDirection || 'push');

  return (
  <ModalDialog onClose={onClose} width="large">
    <ModalHeader>
      <ModalTitle>{editingOrg ? `Edit Organization (Two-Way)` : 'Add Organization (Two-Way)'}</ModalTitle>
    </ModalHeader>
    <ModalBody>
      <Form onSubmit={onSave}>
      {({ formProps }) => (
        <form {...formProps} style={{ padding: token('space.200', '16px') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.300', '24px') }}>

            {/* Connection Details Section */}
            <div>
              <h4 style={{
                margin: `0 0 ${token('space.150', '12px')} 0`,
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C')
              }}>
                Connection Details
              </h4>
              <div className="workflow-grid" style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr',
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="name"
                  defaultValue={editingOrg?.name || ''}
                  isRequired
                  label="Organization Name"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="e.g., Production" autoFocus />
                  )}
                </Field>

                <Field
                  name="remoteUrl"
                  defaultValue={editingOrg?.remoteUrl || ''}
                  isRequired
                  label="Remote Jira URL"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="https://yourorg.atlassian.net" />
                  )}
                </Field>
              </div>
            </div>

            {/* Authentication Section */}
            <div>
              <h4 style={{
                margin: `0 0 ${token('space.150', '12px')} 0`,
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C')
              }}>
                Authentication
              </h4>
              <div className="workflow-grid" style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="remoteEmail"
                  defaultValue={editingOrg?.remoteEmail || ''}
                  isRequired
                  label="Admin Email"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="admin@example.com" />
                  )}
                </Field>

                {editingOrg ? (
                  <>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>API Token</div>
                      <div style={{ fontSize: '13px', color: editingOrg.hasRemoteApiToken ? '#006644' : '#DE350B' }}>
                        {editingOrg.hasRemoteApiToken ? 'Configured' : 'Not configured'}
                      </div>
                      <p style={{ fontSize: '11px', color: token('color.text.subtlest', '#6B778C'), margin: '4px 0 0 0' }}>
                        Existing tokens are never displayed. Leave the replacement field empty to keep the current token.
                      </p>
                    </div>
                    <Field
                      name="replacementRemoteApiToken"
                      label="Replace API Token (optional)"
                    >
                      {({ fieldProps }) => (
                        <TextField {...fieldProps} type="password" placeholder="Enter a new token only to replace it" />
                      )}
                    </Field>
                  </>
                ) : (
                  <Field
                    name="remoteApiToken"
                    isRequired
                    label="API Token"
                  >
                    {({ fieldProps }) => (
                      <TextField {...fieldProps} type="password" placeholder="••••••••••••" />
                    )}
                  </Field>
                )}
              </div>
            </div>

            {/* Sync Configuration Section */}
            <div>
              <h4 style={{
                margin: `0 0 ${token('space.150', '12px')} 0`,
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C')
              }}>
                Sync Configuration
              </h4>
              <div className="workflow-grid" style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr',
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="remoteProjectKey"
                  defaultValue={editingOrg?.remoteProjectKey || ''}
                  isRequired
                  label="Target Project Key"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="PROJ" />
                  )}
                </Field>

                <div>
                  <Field
                    name="jqlFilter"
                    defaultValue={editingOrg?.jqlFilter || ''}
                    label="JQL Filter (optional)"
                  >
                    {({ fieldProps }) => (
                      <TextField {...fieldProps} placeholder="e.g., priority = High AND status != Done" />
                    )}
                  </Field>
                  <p style={{ fontSize: '11px', color: token('color.text.subtlest', '#6B778C'), margin: `${token('space.050', '4px')} 0 0 0` }}>
                    Only issues matching this JQL will sync
                  </p>
                </div>
              </div>
            </div>

            {/* Sync Direction Section */}
            <div>
              <h4 style={{
                margin: `0 0 ${token('space.150', '12px')} 0`,
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C')
              }}>
                Sync Direction
              </h4>
              <div style={{
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="syncDirection"
                  defaultValue={syncDirection}
                  label="Direction"
                >
                  {({ fieldProps }) => (
                    <Select
                      {...fieldProps}
                      options={[
                        { label: 'One-Way (Push Only)', value: 'push' },
                        { label: 'Two-Way (Bidirectional)', value: 'bidirectional' }
                      ]}
                      value={fieldProps.value === 'bidirectional'
                        ? { label: 'Two-Way (Bidirectional)', value: 'bidirectional' }
                        : { label: 'One-Way (Push Only)', value: 'push' }
                      }
                      onChange={(option) => {
                        fieldProps.onChange(option.value);
                        setSyncDirection(option.value);
                      }}
                    />
                  )}
                </Field>

                {syncDirection === 'bidirectional' && (
                  <div style={{ marginTop: '16px' }}>
                    {editingOrg?.incomingWebhookUrl ? (
                      <div style={{
                        background: token('color.background.accent.green.subtlest', '#E3FCEF'),
                        padding: '12px',
                        borderRadius: '4px',
                        border: `1px solid ${token('color.border.accent.green', '#36B37E')}`
                      }}>
                        <h5 style={{ margin: '0 0 8px 0', color: '#006644' }}>Incoming Webhook Configuration</h5>
                        <p style={{ fontSize: '12px', margin: '0 0 8px 0' }}>
                          Configure a System Webhook in the <strong>Remote Jira</strong> with these details:
                        </p>
                        <div style={{ marginBottom: '8px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: '#006644' }}>Base URL:</div>
                          <code style={{
                            display: 'block',
                            padding: '8px',
                            background: '#FFFFFF',
                            borderRadius: '4px',
                            fontSize: '11px',
                            wordBreak: 'break-all',
                            border: '1px solid #A1BDD9'
                          }}>
                            {editingOrg.incomingWebhookUrl}
                          </code>
                        </div>
                        <div style={{ marginBottom: '8px' }}>
                          <p style={{ fontSize: '11px', color: '#172B4D', margin: 0 }}>
                            Use <strong>Rotate Webhook Secret</strong> to generate the complete one-time callback URL, then paste that full URL into the Jira System Webhook. Native Jira webhooks do not need custom headers.
                          </p>
                        </div>
                        <div style={{ marginBottom: '8px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: '#006644' }}>JQL Filter (CRITICAL):</div>
                          <div style={{ fontSize: '11px', color: '#172B4D', marginBottom: '4px' }}>
                            You MUST exclude the sync user to prevent loops!
                          </div>
                          <code style={{
                            display: 'block',
                            padding: '8px',
                            background: '#FFFFFF',
                            borderRadius: '4px',
                            fontSize: '11px',
                            wordBreak: 'break-all',
                            border: '1px solid #A1BDD9'
                          }}>
                            project = "{editingOrg.remoteProjectKey}" AND creator != "{editingOrg.remoteEmail}" AND updatedBy != "{editingOrg.remoteEmail}"
                          </code>
                        </div>
                        <div style={{ fontSize: '11px', color: '#006644' }}>
                          <strong>Events:</strong> Issue Created, Updated, Deleted
                        </div>
                      </div>
                    ) : (
                      <SectionMessage appearance="info">
                        <p>Save this organization to generate the Incoming Webhook URL.</p>
                      </SectionMessage>
                    )}
                  </div>
                )}
              </div>
            </div>

            {editingOrg && (
              <Field
                name="allowedProjects"
                defaultValue={editingOrg?.allowedProjects || []}
              >
                {({ fieldProps }) => <input {...fieldProps} type="hidden" />}
              </Field>
            )}
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: token('space.100', '8px'),
            marginTop: token('space.300', '24px'),
            paddingTop: token('space.200', '16px'),
            borderTop: `1px solid ${token('color.border', '#DFE1E6')}`
          }}>
            <Button appearance="subtle" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" appearance="primary" isLoading={saving}>
              {editingOrg ? 'Save Changes' : 'Add Organization'}
            </Button>
          </div>
        </form>
      )}
    </Form>
    </ModalBody>
  </ModalDialog>
  );
};

export default OrgModal;
