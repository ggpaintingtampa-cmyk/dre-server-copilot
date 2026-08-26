import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  resetKey?: any;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background text-foreground p-4">
          <div className="w-full max-w-md bg-card border border-destructive/50 rounded-xl p-6">
            <h2 className="text-lg font-bold text-destructive mb-2 uppercase tracking-wide">Component Crash</h2>
            <div className="bg-black/50 p-3 rounded overflow-x-auto text-xs font-mono text-zinc-400 mb-4 border border-border">
              {this.state.error?.message || "Unknown error"}
            </div>
            <button 
              className="text-xs font-bold uppercase tracking-wider text-primary hover:underline"
              onClick={() => this.setState({ hasError: false, error: undefined })}
            >
              Reinitialize
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
