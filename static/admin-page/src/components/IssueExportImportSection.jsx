import React, { useState } from 'react';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import Select from '@atlaskit/select';
import Checkbox from '@atlaskit/checkbox';
import { token } from '@atlaskit/tokens';
import { surfaceCard, lozengeButtonStyle, ISSUE_EXPORT_LIMIT } from '../dashboard/presentation';
// Issue Export/Import Section Component - Collapsible
const IssueExportImportSection = ({
  exportJql, setExportJql, exportMode, setExportMode,
  selectedPredefined, setSelectedPredefined, predefinedQueries,
  selectedProject, setSelectedProject, selectedStatus, setSelectedStatus, statusOptions,
  selectedAssignee, setSelectedAssignee, assigneeOptions,
  dayRange, setDayRange, exportLimit, setExportLimit,
  exportIncludeComments, setExportIncludeComments,
  exportIncludeAttachments, setExportIncludeAttachments,
  exportIncludeChangelog, setExportIncludeChangelog,
  exportIncludeLinks, setExportIncludeLinks,
  generateJQL, triggerIssueExport, issueExporting,
  onIssueImportClick, issueImporting, selectedOrg
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={surfaceCard()}>
      <div
        onClick={() => setExpanded(!expanded)}
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(value => !value); }
            }}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h4 style={{ margin: '0 0 4px 0' }}>Issue Export / Import</h4>
          <p style={{ fontSize: '13px', color: '#6B778C', margin: 0 }}>
            Export issues via JQL for migration or backups, or import from a previous export.
          </p>
        </div>
        <span style={{ fontSize: '13px', color: '#6B778C' }}>{expanded ? 'Hide ▲' : 'Show ▼'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: token('space.200', '16px'), display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
          <div style={{ fontSize: '12px', color: '#DE350B', fontWeight: 500 }}>
            ⚠️ Project key is required for export.
          </div>
          
          {/* Export Mode Toggle */}
          <div style={{ display: 'flex', gap: token('space.100', '8px'), alignItems: 'center' }}>
            <label style={{ fontSize: '14px', fontWeight: 500 }}>Export Mode:</label>
            <Button
              appearance={exportMode === 'predefined' ? 'primary' : 'subtle'}
              onClick={() => setExportMode('predefined')}
              style={{ ...lozengeButtonStyle, height: '32px' }}
            >
              Easy Select
            </Button>
            <Button
              appearance={exportMode === 'custom' ? 'primary' : 'subtle'}
              onClick={() => setExportMode('custom')}
              style={{ ...lozengeButtonStyle, height: '32px' }}
            >
              Custom JQL
            </Button>
          </div>

          {/* Easy Select Mode */}
          {exportMode === 'predefined' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px'), padding: '16px', background: token('color.background.neutral.subtle', '#F4F5F7'), borderRadius: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Quick Filters (optional):</label>
                  <Select
                    placeholder="Select a filter to combine with project..."
                    value={selectedPredefined}
                    onChange={setSelectedPredefined}
                    options={predefinedQueries}
                    isClearable
                  />
                </div>

                <div style={{ fontSize: '12px', fontWeight: 500, color: token('color.text'), margin: '8px 0 4px 0' }}>Build Your Query:</div>
                
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#DE350B', marginBottom: '2px', display: 'block' }}>Project Key (REQUIRED):</label>
                  <TextField
                    placeholder="Enter project key, e.g., SCRUM, TEST, PROJ"
                    value={selectedProject?.value || ''}
                    onChange={(e) => setSelectedProject(e.target.value ? { label: e.target.value, value: e.target.value } : null)}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Status:</label>
                  <Select placeholder="Any status" value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} isClearable />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Assignee:</label>
                  <Select placeholder="Any assignee" value={selectedAssignee} onChange={setSelectedAssignee} options={assigneeOptions} isClearable />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Updated within last X days:</label>
                  <TextField type="number" min={1} max={365} value={dayRange} onChange={(e) => setDayRange(Number(e.target.value))} placeholder="30" />
                </div>
              </div>

              <div style={{ marginTop: '8px', padding: '8px', background: token('color.background.neutral'), borderRadius: '4px' }}>
                <div style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '4px' }}>Generated JQL:</div>
                <code style={{ fontSize: '12px', wordBreak: 'break-all' }}>{generateJQL()}</code>
              </div>
            </div>
          )}

          {/* Custom JQL Mode */}
          {exportMode === 'custom' && (
            <div>
              <TextField
                value={exportJql}
                onChange={(event) => setExportJql(event.target.value)}
                placeholder="Enter JQL, e.g., project = ABC AND updated >= -30d"
              />
              <div style={{ fontSize: '12px', color: token('color.text.subtle'), marginTop: '4px' }}>
                Need help with JQL? <a href="https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/" target="_blank" rel="noopener noreferrer">Learn JQL syntax</a>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: '0 0 120px' }}>
              <TextField type="number" min={1} max={ISSUE_EXPORT_LIMIT} value={exportLimit} onChange={(event) => setExportLimit(event.target.value)} placeholder="Max results" />
            </div>
            <div style={{ fontSize: '12px', color: '#6B778C' }}>Max {ISSUE_EXPORT_LIMIT} issues per export</div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.100', '8px') }}>
            <Checkbox label="Comments" isChecked={exportIncludeComments} onChange={(event) => setExportIncludeComments(event.target.checked)} />
            <Checkbox label="Attachments (metadata)" isChecked={exportIncludeAttachments} onChange={(event) => setExportIncludeAttachments(event.target.checked)} />
            <Checkbox label="Issue links" isChecked={exportIncludeLinks} onChange={(event) => setExportIncludeLinks(event.target.checked)} />
            <Checkbox label="Changelog" isChecked={exportIncludeChangelog} onChange={(event) => setExportIncludeChangelog(event.target.checked)} />
          </div>

          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
            <Button appearance="subtle" onClick={triggerIssueExport} isDisabled={!generateJQL().trim()} isLoading={issueExporting} style={lozengeButtonStyle}>
              Export Issues
            </Button>
            <Button appearance="subtle" onClick={onIssueImportClick} isDisabled={!selectedOrg || issueImporting} isLoading={issueImporting} style={lozengeButtonStyle}>
              Import Issues
            </Button>
          </div>
          <div style={{ fontSize: '12px', color: '#6B778C' }}>
            Imports target the currently selected organization.
          </div>
        </div>
      )}
    </div>
  );
};

export default IssueExportImportSection;
