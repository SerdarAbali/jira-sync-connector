# Contributing to Jira Sync Connector

First off, thank you for considering contributing to Jira Sync Connector! It's people like you that make this tool better for everyone.

## Table of Contents
1. [Code of Conduct](#code-of-conduct)
2. [How Can I Contribute?](#how-can-i-contribute)
3. [Development Setup](#development-setup)
4. [Coding Standards](#coding-standards)
5. [Pull Request Process](#pull-request-process)
6. [Community](#community)

---

## Code of Conduct

By participating in this project, you are expected to uphold our Code of Conduct:

### Our Pledge
We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity and expression, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

### Our Standards

**Positive behavior includes:**
- Being respectful and inclusive
- Welcoming newcomers
- Focusing on what is best for the community
- Showing empathy towards others
- Accepting constructive criticism gracefully

**Unacceptable behavior includes:**
- Harassment or discriminatory comments
- Trolling or insulting comments
- Personal or political attacks
- Publishing others' private information
- Other conduct inappropriate in a professional setting

---

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the [existing issues](https://github.com/SerdarAbali/jira-sync-connector/issues) to avoid duplicates.

**Bug Report Template:**

```markdown
**Title:** [Concise description of the bug]

**Description:**
[Detailed description]

**Steps to Reproduce:**
1. Go to '...'
2. Click on '...'
3. See error

**Expected vs Actual Behavior:**
Expected: [what should happen]
Actual: [what actually happens]

**Environment:**
- Forge CLI: [version]
- Node.js: [version]
- OS: [e.g. macOS 14.0]
```

### Suggesting Enhancements

**Enhancement Template:**

```markdown
**Title:** [Feature name]

**Problem:**
[What problem does this solve?]

**Proposed Solution:**
[How would you solve it?]

**Use Cases:**
1. [Use case 1]
2. [Use case 2]
```

---

## Development Setup

### Prerequisites

```bash
# Install Node.js 18+
node --version  # Should be v18 or higher

# Install Forge CLI
npm install -g @forge/cli

# Login to Forge
forge login
```

### Initial Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/jira-sync-connector.git
   cd jira-sync-connector
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. **Deploy to development**
   ```bash
   forge deploy --environment development
   forge install --environment development
   ```

---

## Coding Standards

### JavaScript Style

```javascript
// ✅ Good - ES6+, clear naming
const syncIssue = async (issue) => {
  const { key, fields } = issue;
  return await apiCall(key, fields);
};

// ❌ Avoid - old style
function syncIssue(issue) {
  var key = issue.key;
  return apiCall(key, issue.fields);
}
```

### Documentation

Use JSDoc for all public functions:

```javascript
/**
 * Syncs an issue from source to target Jira
 * @param {Object} issue - The Jira issue
 * @param {Object} config - Sync configuration
 * @returns {Promise<Object>} Synced issue result
 * @throws {Error} If sync fails
 */
async function syncIssue(issue, config) {
  // Implementation
}
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: <type>(<scope>): <subject>
git commit -m "feat(sync): add epic synchronization"
git commit -m "fix(config): resolve persistence issue"
git commit -m "docs(readme): update installation steps"
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

---

## Pull Request Process

### Before Submitting

- [ ] Code follows style guidelines
- [ ] Tests added/updated and passing
- [ ] Documentation updated
- [ ] No console.log statements
- [ ] Lint checks passing (`npm run lint`)

### Creating PR

1. Push your branch
2. Create PR on GitHub
3. Fill out PR template
4. Wait for review

### PR Template

```markdown
## Description
[What does this PR do?]

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
[How was this tested?]

## Checklist
- [ ] Code follows style guidelines
- [ ] Tests pass
- [ ] Documentation updated
```

---

## Community

### Getting Help

- Check [Documentation](README.md)
- Search [Issues](https://github.com/SerdarAbali/jira-sync-connector/issues)
- Ask in [Discussions](https://github.com/SerdarAbali/jira-sync-connector/discussions)

### Recognition

Contributors are recognized in CHANGELOG.md and release notes.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing! 🎉
