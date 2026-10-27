import React from 'react';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import ModalDialog, { ModalTransition, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import OrgModal from '../components/OrgModal';
import ImportSettingsModal from '../components/ImportSettingsModal';
import IssueImportModal from '../components/IssueImportModal';
export default function AdminDialogs({ controller }) {
 const { selectedOrg, saving, importingSettings, importModalOpen, importData, importSections, issueImportModalOpen, issueImportData, issueImportOptions, issueImporting, showOrgModal, setShowOrgModal, editingOrg, setEditingOrg, deleteModalOpen, setDeleteModalOpen, orgToDelete, handleToggleImportSection, handleConfirmImportSettings, handleCloseImportModal, handleSaveOrg, executeDeleteOrg, handleIssueImportOptionChange, handleConfirmIssueImport, handleCancelIssueImport } = controller;
 return <>      {/* Delete Confirmation Modal */}
      <ModalTransition>
        {deleteModalOpen && (
          <ModalDialog onClose={() => setDeleteModalOpen(false)}>
            <ModalHeader>
              <ModalTitle>Delete Organization?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <p>
                Are you sure you want to delete <strong>{orgToDelete?.name}</strong>?
              </p>
              <SectionMessage appearance="warning" title="Configuration will be lost">
                <p>
                  This will remove the connection configuration. However, your issue mappings and sync history will be preserved in the database.
                </p>
              </SectionMessage>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setDeleteModalOpen(false)} isDisabled={saving}>
                Cancel
              </Button>
              <Button appearance="danger" onClick={executeDeleteOrg} isLoading={saving}>
                Delete
              </Button>
            </ModalFooter>
          </ModalDialog>
        )}
      </ModalTransition>

      {/* Org Modal */}
      <ModalTransition>
        {showOrgModal && (
          <OrgModal
            editingOrg={editingOrg}
            onClose={() => { setShowOrgModal(false); setEditingOrg(null); }}
            onSave={handleSaveOrg}
            saving={saving}
          />
        )}
      </ModalTransition>
      <ModalTransition>
        {importModalOpen && (
          <ImportSettingsModal
            importData={importData}
            sections={importSections}
            onToggleSection={handleToggleImportSection}
            onConfirm={handleConfirmImportSettings}
            onClose={handleCloseImportModal}
            importing={importingSettings}
          />
        )}
      </ModalTransition>
      <ModalTransition>
        {issueImportModalOpen && issueImportData && (
          <IssueImportModal
            data={issueImportData}
            options={issueImportOptions}
            onOptionChange={handleIssueImportOptionChange}
            onConfirm={handleConfirmIssueImport}
            onClose={handleCancelIssueImport}
            importing={issueImporting}
            selectedOrg={selectedOrg}
          />
        )}
      </ModalTransition></>;
}
