import React from 'react';
import { createRoot } from 'react-dom/client';
import '@atlaskit/css-reset';
import './dashboard/dashboard.css';
import { App } from './App';
import ErrorBoundary from './components/ErrorBoundary';
const root = document.getElementById('root');
if (root) createRoot(root).render(<ErrorBoundary><App /></ErrorBoundary>);
