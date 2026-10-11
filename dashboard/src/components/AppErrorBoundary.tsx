import { Component, type ErrorInfo, type ReactNode } from "react";

import { Logo } from "@/components/logo";

/**
 * Last-resort error boundary for the whole SPA.
 *
 * WHY THIS EXISTS (2026-10-11): the dashboard had NO error boundary anywhere.
 * React unmounts the ENTIRE tree when a render throws and nothing catches it,
 * so a single bad message — most often the lazy `openuiRenderer` chunk failing
 * to load (a ChunkLoadError after a redeploy, or a flaky mobile network) —
 * turned the whole app into a blank white screen. That is the "asked a question,
 * the screen went blank" report: it is a *failure-mode* bug, not a content bug.
 *
 * The boundary converts an unrecoverable blank screen into a calm, recoverable
 * panel with a Reload button. It is deliberately the OUTERMOST layer: the
 * per-message degradation ([`UIBlock`] in `lib/uiBlocks.tsx`) is the first line
 * of defence and should absorb the common cases before this one is reached.
 *
 * Rendered by BOTH SPAs (`src/main.tsx`, `src/mobile/main.tsx`) so desktop and
 * mobile behave identically.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the trace in the console for diagnosis; there is no backend
    // error-reporting endpoint by design.
    console.error("[dashboard] unhandled render error", error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 py-10 text-center">
        <Logo size={48} />
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-foreground">
            Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            The interface hit an unexpected error and stopped rendering. Your
            conversation is safe — reload to continue.
          </p>
        </div>
        <pre className="max-h-40 max-w-md overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-left text-[11px] text-muted-foreground">
          {error.message || String(error)}
        </pre>
        <button
          type="button"
          onClick={this.reload}
          data-testid="app-error-reload"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Reload
        </button>
      </div>
    );
  }
}
