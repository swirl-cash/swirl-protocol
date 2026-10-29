import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { message: string };

export class WalletErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : 'Unexpected wallet rendering error' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('SWIRL wallet rendering failed', error, info.componentStack);
  }

  render() {
    if (!this.state.message) return this.props.children;
    return <main className="wallet-shell loading-screen">
      <section className="form-view" role="alert">
        <p className="eyebrow">RECOVERABLE WALLET ERROR</p>
        <h1>Wallet display interrupted</h1>
        <p className="section-copy">Your encrypted wallet has not been deleted. Reload to return to the unlock screen.</p>
        <p className="error-message">{this.state.message}</p>
        <button className="primary-button" onClick={() => window.location.reload()}>Reload wallet</button>
      </section>
    </main>;
  }
}
