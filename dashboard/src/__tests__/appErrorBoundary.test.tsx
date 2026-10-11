/**
 * The app-level boundary must turn an unrecoverable render throw into a
 * recoverable panel — never a blank screen (2026-10-11).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";

vi.mock("@/components/logo", () => ({
  Logo: () => <div data-testid="logo" />,
}));

function Boom(): never {
  throw new Error("kaboom");
}

describe("AppErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the fallback panel instead of unmounting when a child throws", () => {
    // React logs the caught error loudly; silence it for a clean test run.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary label="the dashboard">
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByTestId("app-error-reload")).toBeInTheDocument();
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <div data-testid="fine">ok</div>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("fine")).toBeInTheDocument();
  });
});
