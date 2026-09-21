import { BarChart3, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import type { UsageSummary } from "@/lib/types";

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TruncateModelId(model: string, maxLen = 40): string {
  if (model.length <= maxLen) return model;
  return model.slice(0, maxLen - 1) + "…";
}

function SparklineSvg({
  data,
  color = "hsl(var(--primary))",
  height = 60,
  width = 280,
}: {
  data: number[];
  color?: string;
  height?: number;
  width?: number;
}) {
  if (data.length === 0) return null;

  const maxVal = Math.max(...data, 1);
  const minVal = Math.min(...data);
  const range = maxVal - minVal || 1;

  const points = data.map((val, i) => {
    const x = (i / (data.length - 1 || 1)) * width;
    const y = height - ((val - minVal) / range) * (height - 10) - 5;
    return `${x},${y}`;
  });

  const path = `M${points.join(" L")}`;

  // Area path (fill to bottom)
  const areaPoints = [
    `M${points[0]}`,
    ...points.slice(1),
    `L${width},${height}`,
    `L0,${height}`,
    "Z",
  ].join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-full"
      role="img"
      aria-label="Token usage over time"
    >
      <defs>
        <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPoints} fill="url(#sparkline-gradient)" />
      <path d={path} stroke={color} strokeWidth="2" fill="none" />
      {data.length === 1 && (
        <circle
          cx={width / 2}
          cy={height - ((data[0] - minVal) / range) * (height - 10) - 5}
          r={4}
          fill={color}
        />
      )}
    </svg>
  );
}

export function UsageCard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    api
      .usageSummary(days)
      .then((data) => {
        if (mounted) setSummary(data);
      })
      .catch((err) => {
        if (mounted) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [days]);

  if (loading) {
    return (
      <Card data-testid="usage-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary animate-pulse" />
            Token Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="h-4 bg-muted animate-pulse rounded w-1/4" />
            <div className="h-4 bg-muted animate-pulse rounded w-1/3" />
            <div className="h-4 bg-muted animate-pulse rounded w-1/5" />
            <div className="h-32 bg-muted animate-pulse rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !summary?.available) {
    return (
      <Card data-testid="usage-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" />
            Token Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No usage data yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { totals, by_model, timeseries } = summary;

  // Prepare time-series data for chart: plot both prompt and cached tokens
  const promptSeries = timeseries.map((d) => d.prompt_tokens);
  const cachedSeries = timeseries.map((d) => d.cached_tokens);

  return (
    <Card data-testid="usage-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" />
            Token Usage
          </CardTitle>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-auto min-w-[140px]">
              <SelectValue placeholder="Window" />
              <ChevronDown className="size-4 opacity-50" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-sm text-muted-foreground">Window: {days} day{days > 1 ? "s" : ""}</div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline stats */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-foreground">{formatNumber(totals.total_tokens)}</div>
            <div className="text-xs text-muted-foreground">Total Tokens</div>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-primary">{formatNumber(totals.cached_tokens)}</div>
            <div className="text-xs text-muted-foreground">Cached Tokens</div>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {totals.cache_hit_pct.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">Cache Hit %</div>
          </div>
        </div>

        <Separator />

        {/* Time-series chart */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Token Usage Over Time</span>
            <span className="text-xs text-muted-foreground">
              {timeseries.length} bucket{timeseries.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="h-40 relative" style={{ minHeight: "160px" }}>
            {/* Prompt tokens (background) */}
            <SparklineSvg
              data={promptSeries}
              color="hsl(var(--muted-foreground) / 0.4)"
              height={160}
            />
            {/* Cached tokens (foreground) */}
            <SparklineSvg
              data={cachedSeries}
              color="hsl(var(--primary))"
              height={160}
            />
            {/* Legend */}
            <div className="absolute bottom-2 left-2 flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-primary" />
                <span>Cached</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-muted-foreground/40" />
                <span>Prompt</span>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Per-model breakdown */}
        {by_model.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Per Model</span>
              <span className="text-xs text-muted-foreground">{by_model.length} model(s)</span>
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {by_model.map((m, i) => (
                <div
                  key={`${m.model}-${m.provider}-${i}`}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Badge variant="outline" className="text-xs font-mono whitespace-nowrap shrink-0">
                      {TruncateModelId(m.model)}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate">
                      {m.provider}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    <span className="font-medium text-foreground">{m.requests} req</span>
                    <span className="font-medium text-primary">
                      {m.cache_hit_pct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}