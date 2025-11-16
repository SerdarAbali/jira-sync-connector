# Changelog

All notable changes to the Jira Sync Connector project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned Features
- Bidirectional synchronization
- Epic-Story relationship preservation
- Story points and custom field mapping
- User assignment mapping between organizations
- Sprint synchronization
- Attachment synchronization
- Webhook support

---

## [1.0.0] - 2025-11-16

### Added
- Initial release of Jira Sync Connector
- Real-time issue synchronization from Organization A to Organization B
- Admin configuration UI in Jira Settings
- Issue created event handler
- Issue updated event handler
- Comment synchronization
- Epic support and synchronization
- Loop prevention mechanism to avoid infinite syncs
- Status synchronization with mapping
- Configuration storage with encrypted API tokens
- Issue mapping storage (source → target)
- Error handling and retry logic
- Comprehensive logging
- Support for standard Jira issue types (Story, Bug, Task, Epic)
- Field transformation logic
- API rate limiting handling

### Configuration
- Remote Jira URL configuration
- API token authentication
- Project key mapping
- Sync rules configuration

### Documentation
- README with installation instructions
- ARCHITECTURE documentation
- API documentation
- DEVELOPMENT guide
- DEPLOYMENT guide
- TROUBLESHOOTING guide
- CONTRIBUTING guidelines

### Security
- Encrypted storage for API tokens
- Secure credential handling
- Input validation on all API calls
- Permission-based access control

---

## [0.9.0] - 2025-11-10 (Beta)

### Added
- Beta release for testing
- Basic issue synchronization
- Configuration page prototype
- Initial loop detection

### Fixed
- Admin page not appearing in Jira sidebar
- Configuration not persisting correctly
- Event handlers not triggering consistently

### Known Issues
- Comments not syncing reliably
- Performance issues with large issues
- Epic relationships not maintained

---

## [0.5.0] - 2025-11-05 (Alpha)

### Added
- Proof of concept implementation
- Basic Forge app structure
- Issue created handler
- Simple API integration with remote Jira
- Basic configuration storage

### Known Issues
- No loop prevention
- No admin UI
- Limited error handling
- No comment sync
- No status mapping

---

## Version History

### Version Numbering

We use [Semantic Versioning](https://semver.org/):
- **MAJOR** version for incompatible API changes
- **MINOR** version for new functionality in a backward compatible manner
- **PATCH** version for backward compatible bug fixes

### Release Schedule

- **Major releases**: Every 6-12 months
- **Minor releases**: Every 1-3 months
- **Patch releases**: As needed for bug fixes

---

## Upgrade Guide

### From 0.9.0 to 1.0.0

**Breaking Changes:**
- None - backward compatible upgrade

**New Features:**
- Epic synchronization
- Comment sync improvements
- Enhanced loop detection

**Migration Steps:**
1. Backup your configuration:
   ```bash
   forge storage:export > backup.json
   ```

2. Deploy new version:
   ```bash
   forge deploy --environment production
   ```

3. Verify configuration is intact:
   - Go to Jira → Settings → Apps → Sync Connector
   - Confirm all settings are present

4. Test with a new issue:
   - Create test issue
   - Verify it syncs correctly
   - Check comments and status

---

## Detailed Release Notes

### [1.0.0] - Full Details

#### Features

**Issue Synchronization**
- Automatic sync on issue creation
- Real-time sync on issue updates
- Support for all standard issue types
- Custom field mapping capability

**Comment Synchronization**
- Comments sync with attribution
- Maintains comment thread order
- Supports rich text formatting (ADF)

**Epic Management**
- Epics sync as epic issue type
- Epic color and name preserved
- Epic-issue relationships tracked

**Status Mapping**
- Configurable status mapping
- Automatic transition to mapped status
- Handles unavailable transitions gracefully

**Loop Prevention**
- Issue property-based detection
- Timestamp comparison
- Sync version tracking

**Configuration UI**
- Easy-to-use admin interface
- Connection testing capability
- Secure credential storage
- Visual feedback on save

#### Improvements

**Performance**
- Optimized API calls
- Reduced storage reads/writes
- Implemented caching for configuration
- Parallel processing where possible

**Reliability**
- Enhanced error handling
- Automatic retry logic with exponential backoff
- Better timeout handling
- Graceful degradation on errors

**Security**
- API tokens stored encrypted
- No sensitive data in logs
- Input validation on all inputs
- Secure external fetch configuration

**Developer Experience**
- Comprehensive documentation
- Example code snippets
- Troubleshooting guides
- Clear error messages

#### Bug Fixes
- Fixed admin page not appearing in sidebar (#1)
- Resolved configuration persistence issues (#3)
- Fixed duplicate issue creation (#5)
- Corrected status mapping for custom workflows (#7)
- Fixed comment formatting issues (#9)

#### Known Limitations
- Only one-way sync (A → B)
- No attachment synchronization
- Limited to 1 GB storage
- No user assignment mapping
- 25-second function timeout

#### Dependencies
- @forge/api: ^3.0.0
- @forge/bridge: ^3.0.0
- @forge/ui: ^1.0.0

---

## Future Roadmap

### Version 1.1.0 (Q1 2026)
- [ ] Attachment synchronization
- [ ] Enhanced error reporting dashboard
- [ ] Bulk sync capability for existing issues
- [ ] Field mapping UI

### Version 1.2.0 (Q2 2026)
- [ ] User assignment mapping
- [ ] Custom field mapping UI
- [ ] Sprint synchronization
- [ ] Advanced filtering options

### Version 2.0.0 (Q3 2026)
- [ ] Bidirectional synchronization
- [ ] Multi-organization support (3+ orgs)
- [ ] Webhook integration
- [ ] Advanced conflict resolution
- [ ] Performance metrics dashboard

### Version 2.1.0 (Q4 2026)
- [ ] Issue link synchronization
- [ ] Workflow transition sync
- [ ] Time tracking sync
- [ ] Automation rules integration

---

## Deprecation Notices

### Current Deprecations
None at this time.

### Planned Deprecations
- **v2.0.0**: Legacy configuration format will be deprecated in favor of new unified config schema

---

## Security Updates

### [1.0.0] - 2025-11-16
- Updated dependency: @forge/api to 3.0.0 (security patches)
- Enhanced input validation to prevent injection attacks
- Improved error messages to avoid sensitive data leakage

### Security Policy
For security vulnerabilities, please see [SECURITY.md](SECURITY.md) or email security@example.com.

---

## Breaking Changes Log

### Version 1.0.0
No breaking changes from 0.9.0.

---

## Contributor Recognition

### Version 1.0.0
- **Serdar Abali** (@SerdarAbali) - Core development, architecture, documentation

### Contributing
Want to be listed here? Check out our [Contributing Guide](CONTRIBUTING.md)!

---

## Support

For questions about releases:
- Check [GitHub Releases](https://github.com/SerdarAbali/jira-sync-connector/releases)
- Review [Documentation](README.md)
- Open an [Issue](https://github.com/SerdarAbali/jira-sync-connector/issues)

---

## Links

- [Homepage](https://github.com/SerdarAbali/jira-sync-connector)
- [Issue Tracker](https://github.com/SerdarAbali/jira-sync-connector/issues)
- [Documentation](https://github.com/SerdarAbali/jira-sync-connector#readme)
- [Release Notes](https://github.com/SerdarAbali/jira-sync-connector/releases)

[Unreleased]: https://github.com/SerdarAbali/jira-sync-connector/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/SerdarAbali/jira-sync-connector/releases/tag/v1.0.0
[0.9.0]: https://github.com/SerdarAbali/jira-sync-connector/releases/tag/v0.9.0
[0.5.0]: https://github.com/SerdarAbali/jira-sync-connector/releases/tag/v0.5.0
