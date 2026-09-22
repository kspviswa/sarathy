import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    status: vi.fn(),
    usageSummary: vi.fn(),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({
    theme: "light",
    setTheme: vi.fn(),
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/components/ui/card", () => {
  const Card = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardHeader = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardTitle = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardDescription = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardContent = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardFooter = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  return { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
});

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className, variant, ...props }: any) => <span className={className} {...props}>{children}</span>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectItem: ({ children, value, ...props }: any) => <div value={value} {...props}>{children}</div>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: ({ className, ...props }: any) => <hr className={className} {...props} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, ...props }: any) => React.cloneElement(children as React.ReactElement, props),
  DropdownMenuContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

import { StatusView as DesktopStatusView } from "@/views/StatusView";
import { StatusView as MobileStatusView } from "@/mobile/StatusView";
import { api } from "@/lib/api";

const mockStatusResponse = {
  version: "0.9.6",
  gateway: { running: true, pid: 12345 },
  model: "test-model",
  provider: "test-provider",
  workspace: "/test/workspace",
  channels: ["telegram", "discord"],
  dashboard: { host: "localhost", port: 8080, streaming: true, pairingKeyCount: 2 },
};

const mockUsageSummary = {
  available: true,
  window_days: 7,
  totals: {
    requests: 10,
    prompt_tokens: 50000,
    cached_tokens: 15000,
    completion_tokens: 20000,
    total_tokens: 70000,
    cache_hit_pct: 30.0,
  },
  by_model: [
    {
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      requests: 6,
      prompt_tokens: 30000,
      cached_tokens: 10000,
      completion_tokens: 12000,
      cache_hit_pct: 33.3,
    },
    {
      model: "local/llama-3.1-8b",
      provider: "ollama",
      requests: 4,
      prompt_tokens: 20000,
      cached_tokens: 5000,
      completion_tokens: 8000,
      cache_hit_pct: 25.0,
    },
  ],
  timeseries: [
    { ts: "2026-09-15T00:00:00Z", prompt_tokens: 5000, cached_tokens: 1500, completion_tokens: 2000, cache_hit_pct: 30.0 },
    { ts: "2026-09-16T00:00:00Z", prompt_tokens: 8000, cached_tokens: 2400, completion_tokens: 3200, cache_hit_pct: 30.0 },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (api.status as any).mockResolvedValue(mockStatusResponse);
  (api.usageSummary as any).mockResolvedValue(mockUsageSummary);
});

afterEach(() => {
  vi.useRealTimers();
});

function getCardElements(container: HTMLElement, testIds: string[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const testId of testIds) {
    const el = container.querySelector(`[data-testid="${testId}"]`);
    if (el) result.push(el as HTMLElement);
  }
  return result;
}

function getCardOrder(container: HTMLElement): string[] {
  const cards = container.querySelectorAll("[data-testid]");
  return Array.from(cards)
    .filter((el) => el.hasAttribute("data-testid"))
    .map((el) => el.getAttribute("data-testid")!);
}

describe("StatusView — Token Usage card ordering", () => {
  describe("Desktop StatusView", () => {
    it("renders UsageCard before Gateway card", async () => {
      const { container } = render(<DesktopStatusView onLoggedOut={vi.fn()} />);

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const usageCard = container.querySelector('[data-testid="usage-card"]');
      expect(usageCard).toBeInTheDocument();

      // Find Gateway card by looking for the text "Gateway" in a CardTitle
      const gatewayTitle = Array.from(container.querySelectorAll("div")).find((el) =>
        el.textContent?.trim() === "Gateway" || el.textContent?.includes("Gateway")
      );
      // The Gateway card should exist
      expect(gatewayTitle).toBeInTheDocument();

      // Verify UsageCard appears before Gateway card in DOM order
      const usageCardEl = usageCard!;
      // Find the Card wrapper for Gateway (parent Card element)
      const gatewayCardEl = gatewayTitle!.closest('[data-testid="usage-card"]') ?? gatewayTitle!.closest("div")!.parentElement!;
      
      // If compareDocumentPosition doesn't work well, just verify by text order
      const textContent = container.textContent || "";
      const usageIndex = textContent.indexOf("Token Usage");
      const gatewayIndex = textContent.indexOf("Gateway");
      expect(usageIndex).toBeLessThan(gatewayIndex);
    });

    it("UsageCard is the first content card after header", async () => {
      const { container } = render(<DesktopStatusView onLoggedOut={vi.fn()} />);

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const usageCard = container.querySelector('[data-testid="usage-card"]');
      expect(usageCard).toBeInTheDocument();

      // Get the main container
      const mainContainer = container.querySelector(".mx-auto");
      expect(mainContainer).toBeInTheDocument();

      // Check text content order
      const textContent = mainContainer!.textContent || "";
      const usageIndex = textContent.indexOf("Token Usage");
      const gatewayIndex = textContent.indexOf("Gateway");
      const channelsIndex = textContent.indexOf("Channels");
      const dashboardIndex = textContent.indexOf("Dashboard");

      expect(usageIndex).toBeLessThan(gatewayIndex);
      expect(gatewayIndex).toBeLessThan(channelsIndex);
      expect(channelsIndex).toBeLessThan(dashboardIndex);
    });
  });

  describe("Mobile StatusView", () => {
    it("renders UsageCard before Gateway card", async () => {
      const { container } = render(<MobileStatusView onLoggedOut={vi.fn()} />);

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const usageCard = container.querySelector('[data-testid="usage-card"]');
      expect(usageCard).toBeInTheDocument();

      // Verify by text content order
      const textContent = container.textContent || "";
      const usageIndex = textContent.indexOf("Token Usage");
      const gatewayIndex = textContent.indexOf("Gateway");
      expect(usageIndex).toBeLessThan(gatewayIndex);
    });

    it("UsageCard appears first among content cards in mobile view", async () => {
      const { container } = render(<MobileStatusView onLoggedOut={vi.fn()} />);

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const usageCard = container.querySelector('[data-testid="usage-card"]');
      expect(usageCard).toBeInTheDocument();

      // Get the content area
      const contentArea = container.querySelector(".flex-1.overflow-y-auto");
      expect(contentArea).toBeInTheDocument();

      // Check text content order
      const textContent = contentArea!.textContent || "";
      const usageIndex = textContent.indexOf("Token Usage");
      const gatewayIndex = textContent.indexOf("Gateway");
      const channelsIndex = textContent.indexOf("Channels");
      const dashboardIndex = textContent.indexOf("Dashboard");

      expect(usageIndex).toBeLessThan(gatewayIndex);
      expect(gatewayIndex).toBeLessThan(channelsIndex);
      expect(channelsIndex).toBeLessThan(dashboardIndex);
    });
  });
});