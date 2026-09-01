import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  message: string | null;
}

/**
 * App-wide error boundary (F11). Catches render-time exceptions anywhere in the tree
 * and shows a friendly recovery screen instead of a blank white page. Logs the error
 * to the console (and any attached monitoring) for diagnosis.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : 'Unexpected error' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Unhandled UI error:', error, info?.componentStack);
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, message: null });
    window.location.assign('/');
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#1c1840] to-[#241f53] p-4">
        <div className="w-full max-w-md rounded-lg bg-card p-8 text-center shadow-card-hover">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-red-100 text-2xl">!</div>
          <h1 className="text-xl font-extrabold tracking-tight">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The screen ran into an unexpected error. Your data is safe. You can return to the dashboard and try again.
          </p>
          {this.state.message ? (
            <p className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-left text-xs text-muted-foreground">{this.state.message}</p>
          ) : null}
          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={this.handleReload}
              className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
            >
              Return to dashboard
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md border border-input px-4 py-2 text-sm font-semibold hover:bg-muted"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
