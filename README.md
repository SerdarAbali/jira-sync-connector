# Jira Sync Connector

A custom Atlassian Forge app that enables real-time, two-way synchronization of issues between two Jira Cloud organizations. Built on Atlassian's serverless infrastructure—no external hosting required.

## 🌟 Features

### Currently Implemented (Phase 1)
- ✅ **Real-time Issue Sync**: Automatic synchronization when issues are created or updated
- ✅ **Status Synchronization**: Keep issue statuses in sync across organizations
- ✅ **Comment Sync**: Propagate comments between synced issues
- ✅ **Epic Support**: Sync epics and maintain epic relationships
- ✅ **Loop Prevention**: Smart detection to prevent infinite sync loops
- ✅ **Admin Configuration UI**: Easy-to-use interface for setting up sync connections

### Roadmap

#### Phase 2: Enhanced Two-Way Sync
- [ ] Bidirectional synchronization
- [ ] Epic-Story parent-child relationship preservation
- [ ] Story points and custom field mapping
- [ ] User assignment mapping between organizations
- [ ] Sprint synchronization

#### Phase 3: Multi-Organization Support
- [ ] Support for 3+ Jira organizations
- [ ] Selective syncing by issue type and labels
- [ ] Advanced filtering and sync rules
- [ ] Configurable sync rules engine

#### Phase 4: Enterprise Features
- [ ] Attachment synchronization
- [ ] Webhook support for additional integrations
- [ ] Comprehensive audit logging
- [ ] Performance metrics dashboard
- [ ] Scheduled sync fallback mechanism

## 🏗️ Architecture

```
┌─────────────────────────┐
│   Jira Organization A   │
│  (serdarjiraone)        │
│                         │
│  ┌──────────────────┐   │
│  │  Forge App       │   │
│  │  ├─ Triggers     │   │
│  │  ├─ Functions    │   │
│  │  └─ Storage      │   │
│  └──────────────────┘   │
└──────────┬──────────────┘
           │
           │ REST API
           │ (OAuth/API Token)
           │
           ▼
┌─────────────────────────┐
│   Jira Organization B   │
│  (serdarjiratwo)        │
│                         │
│  ┌──────────────────┐   │
│  │  Issues          │   │
│  │  Projects        │   │
│  │  Workflows       │   │
│  └──────────────────┘   │
└─────────────────────────┘
```

## 📋 Prerequisites

- **Node.js**: Version 18.x or higher
- **macOS/Linux/Windows**: Development environment
- **Forge CLI**: Atlassian Forge command-line tools
- **Jira Cloud**: Two Jira Cloud organizations
  - Admin access to Organization A (where the app will be installed)
  - API access to Organization B (target for sync)

## 🚀 Installation

### 1. Install Node.js

**macOS (using Homebrew):**
```bash
brew install node
```

**Verify installation:**
```bash
node --version  # Should be 18.x or higher
npm --version
```

### 2. Install Forge CLI

```bash
npm install -g @forge/cli
```

### 3. Login to Forge

```bash
forge login
```

This will open your browser to authenticate with your Atlassian account.

### 4. Clone the Repository

```bash
git clone https://github.com/SerdarAbali/jira-sync-connector.git
cd jira-sync-connector
```

### 5. Install Dependencies

```bash
npm install
```

## ⚙️ Configuration

### 1. Set Up Jira Organizations

You'll need two Jira Cloud organizations:

- **Organization A** (Source): Where the Forge app will be installed
- **Organization B** (Target): Where issues will be synced to

### 2. Generate API Token for Organization B

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **"Create API token"**
3. Give it a name (e.g., "Jira Sync Connector")
4. Copy the token—you'll need this for configuration

### 3. Deploy the App

**Deploy to development environment:**
```bash
forge deploy
```

**Install on your Jira site:**
```bash
forge install
```

Select your Jira site (Organization A) when prompted.

### 4. Configure Sync Settings

1. Go to your Jira site → **Settings** (⚙️)
2. Navigate to **Apps** → **Manage apps**
3. Find **"Sync Connector"** in the left sidebar
4. Enter the following:
   - **Remote Jira URL**: `https://your-org-b.atlassian.net`
   - **Email**: Your Atlassian account email
   - **API Token**: The token you generated in step 2
   - **Project Key**: The project key in Organization B where issues should be synced

5. Click **"Save Configuration"**

## 🔧 Development

### Running in Development Mode

Use Forge tunnel for real-time development:

```bash
forge tunnel
```

This creates a tunnel to your local development environment, allowing you to test changes without deploying.

### Project Structure

```
jira-sync-connector/
├── src/
│   ├── index.js           # Main entry point with sync logic
│   ├── config.js          # Configuration page component
│   └── utils/             # Helper functions
├── static/
│   └── admin/             # Static assets for admin UI
├── manifest.yml           # Forge app manifest
├── package.json           # Node.js dependencies
├── .gitignore            # Git ignore rules
└── README.md             # This file
```

### Key Files

**manifest.yml:**
Defines the app's modules, permissions, and triggers:
- `jira:adminPage` - Configuration UI
- `trigger:issue-created` - Listens for new issues
- `trigger:issue-updated` - Listens for issue updates

**src/index.js:**
Contains the core sync logic:
- `syncIssue()` - Main function triggered by Jira events
- `syncToRemote()` - Handles API calls to remote Jira
- `configPage()` - Serves the admin configuration UI

### Viewing Logs

```bash
forge logs
```

Tail logs in real-time:
```bash
forge logs --follow
```

## 🧪 Testing

### Manual Testing

1. **Create an issue** in Organization A
   - Verify it appears in Organization B
   - Check that all fields are synced correctly

2. **Update an issue** in Organization A
   - Update summary, description, status
   - Verify changes reflect in Organization B

3. **Add comments** in Organization A
   - Verify comments appear in Organization B

4. **Test epics**
   - Create an epic in Organization A
   - Verify epic is created in Organization B

### Automated Testing

```bash
npm test
```

## 📦 Deployment

### Deploy to Production

```bash
# Build and deploy
forge deploy --environment production

# Install on production site
forge install --environment production
```

## 🔐 Security Considerations

### Credentials Storage
- API tokens are stored securely in Forge's encrypted storage
- Never commit API tokens or credentials to version control
- Use `.gitignore` to exclude sensitive files

### Permissions
The app requires the following Jira permissions:
- `read:jira-work` - Read issues and projects
- `write:jira-work` - Create and update issues
- `storage:app` - Store configuration data

### API Rate Limiting
- Forge automatically handles rate limiting
- The app includes retry logic for failed API calls

## 🐛 Troubleshooting

### Issue: Admin page not showing up

**Solution:**
1. Verify the app is installed: `forge install --list`
2. Check app permissions in Jira Settings → Apps
3. Redeploy: `forge deploy`

### Issue: Issues not syncing

**Solution:**
1. Check logs: `forge logs`
2. Verify API token is valid
3. Confirm remote Jira URL is correct
4. Check project key exists in Organization B

### Issue: Loop prevention triggering incorrectly

**Solution:**
- Check the `syncedBy` field in issue properties
- Clear app storage if needed: Contact Atlassian Support

### Issue: Deployment fails

**Solution:**
```bash
# Clear local cache
rm -rf node_modules package-lock.json
npm install

# Redeploy
forge deploy
```

## 📚 Resources

- [Atlassian Forge Documentation](https://developer.atlassian.com/platform/forge/)
- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Forge Events Reference](https://developer.atlassian.com/platform/forge/events-reference/jira/)
- [Custom UI Guide](https://developer.atlassian.com/platform/forge/custom-ui/)

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Test thoroughly** on actual Jira instances
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your fork**: `git push origin feature/amazing-feature`
7. **Open a Pull Request**

### Development Guidelines

- Follow the existing code style
- Add comments for complex logic
- Update documentation for new features
- Test on real Jira instances before submitting
- Include unit tests for new functions

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👥 Authors

- **Serdar Abali** - Initial work - [@SerdarAbali](https://github.com/SerdarAbali)

## 🙏 Acknowledgments

- Built with [Atlassian Forge](https://developer.atlassian.com/platform/forge/)
- UI components from [Atlassian Design System](https://atlassian.design/)
- Community feedback and contributions

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/SerdarAbali/jira-sync-connector/issues)
- **Discussions**: [GitHub Discussions](https://github.com/SerdarAbali/jira-sync-connector/discussions)
- **Forge Documentation**: https://developer.atlassian.com/platform/forge/

## 🔗 Quick Links

- [Report a Bug](https://github.com/SerdarAbali/jira-sync-connector/issues/new?template=bug_report.md)
- [Request a Feature](https://github.com/SerdarAbali/jira-sync-connector/issues/new?template=feature_request.md)
- [View Changelog](CHANGELOG.md)

---

**Made with ❤️ for seamless Jira collaboration across organizations**
