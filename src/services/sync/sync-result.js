import { LOG_EMOJI, OPERATION_RESULT } from '../../constants.js';
import { safeErrorSummary } from '../../utils/redaction.js';

// Class to track sync operation results
export class SyncResult {
  constructor(operation) {
    this.operation = operation;
    this.success = true;
    this.warnings = [];
    this.errors = [];
    this.details = {
      attachments: { success: 0, failed: 0, skipped: 0, errors: [] },
      links: { success: 0, failed: 0, skipped: 0, errors: [] },
      transitions: { success: 0, failed: 0, errors: [] },
      comments: { success: 0, failed: 0, errors: [] },
      fields: { updated: [], failed: [] }
    };
  }

  addWarning(message) {
    const safeMessage = safeErrorSummary(message);
    this.warnings.push(safeMessage);
    console.warn(`${LOG_EMOJI.WARNING} ${safeMessage}`);
  }

  addError(message) {
    const safeMessage = safeErrorSummary(message);
    this.errors.push(safeMessage);
    this.success = false;
    console.error(`${LOG_EMOJI.ERROR} ${safeMessage}`);
  }

  addAttachmentSuccess(filename) {
    this.details.attachments.success++;
  }

  addAttachmentFailure(filename, error) {
    void filename;
    const safeError = safeErrorSummary(error);
    this.details.attachments.failed++;
    this.details.attachments.errors.push(`attachment: ${safeError}`);
    this.addWarning(`Attachment failed: ${safeError}`);
  }

  addAttachmentSkipped(filename, reason) {
    this.details.attachments.skipped++;
  }

  addLinkSuccess(linkedIssue, linkType) {
    this.details.links.success++;
  }

  addLinkFailure(linkedIssue, error) {
    const safeError = safeErrorSummary(error);
    this.details.links.failed++;
    this.details.links.errors.push(`${linkedIssue}: ${safeError}`);
    this.addWarning(`Link failed: ${linkedIssue} - ${safeError}`);
  }

  addLinkSkipped(linkedIssue, reason) {
    this.details.links.skipped++;
  }

  addTransitionSuccess(status) {
    this.details.transitions.success++;
  }

  addTransitionFailure(status, error) {
    const safeError = safeErrorSummary(error);
    this.details.transitions.failed++;
    this.details.transitions.errors.push(`${status}: ${safeError}`);
    this.addWarning(`Transition failed: ${status} - ${safeError}`);
  }

  logSummary(issueKey, remoteKey) {
    const hasWarnings = this.warnings.length > 0;
    const hasErrors = this.errors.length > 0;

    let status = OPERATION_RESULT.SUCCESS;
    if (hasErrors) status = OPERATION_RESULT.FAILURE;
    else if (hasWarnings) status = OPERATION_RESULT.PARTIAL;

    // Clear separator for visibility
    console.log(`${LOG_EMOJI.SUMMARY} ════════════════════════════════════════════════════`);
    console.log(`${LOG_EMOJI.SUMMARY} SYNC SUMMARY: ${issueKey}${remoteKey ? ' → ' + remoteKey : ''}`);
    console.log(`${LOG_EMOJI.SUMMARY} Status: ${status.toUpperCase()}`);

    // Attachments
    const totalAttachments = this.details.attachments.success + this.details.attachments.failed + this.details.attachments.skipped;
    if (totalAttachments > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.ATTACHMENT} Attachments: ${this.details.attachments.success}/${totalAttachments} synced, ${this.details.attachments.failed} failed, ${this.details.attachments.skipped} skipped`);
    }

    // Links
    const totalLinks = this.details.links.success + this.details.links.failed + this.details.links.skipped;
    if (totalLinks > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.LINK} Links: ${this.details.links.success}/${totalLinks} synced, ${this.details.links.failed} failed, ${this.details.links.skipped} skipped`);
    }

    // Transitions
    const totalTransitions = this.details.transitions.success + this.details.transitions.failed;
    if (totalTransitions > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.STATUS} Transitions: ${this.details.transitions.success}/${totalTransitions} successful`);
    }

    // Comments
    const totalComments = this.details.comments.success + this.details.comments.failed;
    if (totalComments > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.COMMENT} Comments: ${this.details.comments.success}/${totalComments} synced`);
    }

    // Warnings
    if (this.warnings.length > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.WARNING} Warnings: ${this.warnings.length}`);
      this.warnings.forEach(w => console.log(`${LOG_EMOJI.SUMMARY}    - ${w}`));
    }

    // Errors
    if (this.errors.length > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.ERROR} Errors: ${this.errors.length}`);
      this.errors.forEach(e => console.log(`${LOG_EMOJI.SUMMARY}    - ${e}`));
    }

    console.log(`${LOG_EMOJI.SUMMARY} ════════════════════════════════════════════════════`);

    return status;
  }
}
