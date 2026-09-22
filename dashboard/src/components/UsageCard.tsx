import { BarChart3, ChevronDown, Filter } from "lucide-react";
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

const ALL_MODELS = "__all__";

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
  height = 160,
  width = 280,
  maxValue,
  className = "w-full h-full",
}: {
  data: number[];
  color?: string;
  height?: number;
  width?: number;
  /** Shared y-axis maximum so multiple series are directly comparable. */
  maxValue?: number;
  className?: string;
}) {
  if (data.length === 0) return null;

  const maxVal = Math.max(maxValue ?? Math.max(...data, 1), 1);
  const minVal = 0;
  const range = maxVal - minVal || 1;

  const points = data.map((val, i) => {
    const x = data.length === 1 ? width / 2 : (i / (data.length - 1)) * width;
    const y = height - ((val - minVal) / range) * (height - 10) - 5;
    return `${x},${y}`;
  });

  const path =
    data.length === 1 ? `M${points[0]} L${points[0]}` : `M${points.join(" L")}`;

  // Area path (fill to bottom)
  const areaPoints = [
    `M${points[0]}`,
    ...points.slice(1),
    `L${points[points.length - 1].split(",")[0]},${height}`,
    `L${points[0].split(",")[0]},${height}`,
    "Z",
  ].join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
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
  const [model, setModel] = useState<string>(ALL_MODELS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    api
      .usageSummary(days, model === ALL_MODELS ? null : model)
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
  }, [days, model]);

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

  // Unique model ids for the filter dropdown (providers may repeat a model id).
  const modelOptions = Array.from(new Set(by_model.map((m) => m.model))).filter(Boolean);

  // Prepare time-series data for chart: plot both prompt and cached tokens.
  const promptSeries = timeseries.map((d) => d.prompt_tokens);
  const cachedSeries = timeseries.map((d) => d.cached_tokens);
  // Shared y-scale so the two series are visually comparable.
  const sharedMax = Math.max(...promptSeries, ...cachedSeries, 1);

  return (
    <Card data-testid="usage-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" />
            Token Usage
          </CardTitle>
          <div className="flex items-center gap-2">
            {modelOptions.length > 0 && (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-auto min-w-[150px]" aria-label="Filter by model">
                  <Filter className="size-4 opacity-50" />
                  <SelectValue placeholder="All models" />
                  <ChevronDown className="size-4 opacity-50" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MODELS}>All models</SelectItem>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {TruncateModelId(m, 32)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-auto min-w-[140px]" aria-label="Time window">
                <SelectValue placeholder="Window" />
                <ChevronDown className="size-4 opacity-50" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Window: {days} day{days > 1 ? "s" : ""}
          {model !== ALL_MODELS ? ` · ${TruncateModelId(model, 40)}` : " · all models"}
        </div>
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
          <div className="relative h-40 w-full">
            {/* Prompt tokens (background) */}
            <SparklineSvg
              data={promptSeries}
              color="hsl(var(--muted-foreground) / 0.5)"
              height={160}
              maxValue={sharedMax}
              className="absolute inset-0 w-full h-full"
            />
            {/* Cached tokens (foreground) */}
            <SparklineSvg
              data={cachedSeries}
              color="hsl(var(--primary))"
              height={160}
              maxValue={sharedMax}
              className="absolute inset-0 w-full h-full"
            />
            {/* Legend */}
            <div className="absolute bottom-2 left-2 flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-primary" />
                <span>Cached</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-muted-foreground/50" />
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
                <button
                  type="button"
                  key={`${m.model}-${m.provider}-${i}`}
                  onClick={() => setModel(model === m.model ? ALL_MODELS : m.model)}
                  title={model === m.model ? "Clear filter" : `Show only ${m.model}`}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted/50 ${
                    model === m.model ? "bg-muted/60 ring-1 ring-primary/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 text-left">
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
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}