import React from 'react';
import SectionMessage from '@atlaskit/section-message';
import Button from '@atlaskit/button';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error Boundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px' }}>
          <SectionMessage appearance="error" title="Something went wrong">
            <p>{this.state.error?.message || 'An unexpected error occurred'}</p>
            <Button appearance="primary" onClick={() => window.location.reload()}>
              Reload Page
            </Button>
          </SectionMessage>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
