import './lib/translationCompatibility';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WalletErrorBoundary } from './components/WalletErrorBoundary';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WalletErrorBoundary><App /></WalletErrorBoundary></React.StrictMode>,
);
