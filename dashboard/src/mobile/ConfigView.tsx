import { Loader2, RefreshCw, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ConfigResponse, ProviderInfo } from "@/lib/types";

interface FieldDef {
  id: string;
  path: string;
  label: string;
  type: "text" | "number" | "boolean";
  step?: number;
}

const FIELDS: FieldDef[] = [
  { id: "model", path: "agents.defaults.model", label: "Model", type: "text" },
  { id: "temperature", path: "agents.defaults.temperature", label: "Temperature", type: "number", step: 0.1 },
  { id: "maxTokens", path: "agents.defaults.maxTokens", label: "Max tokens", type: "number" },
  { id: "sendProgress", path: "channels.sendProgress", label: "Stream progress", type: "boolean" },
  { id: "sendToolHints", path: "channels.sendToolHints", label: "Stream tool hints", type: "boolean" },
  { id: "dashStreaming", path: "channels.dashboard.streaming", label: "Dashboard streaming", type: "boolean" },
];

function getPath(obj: ConfigResponse, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o == null || typeof o !== "object") return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

function setPath(obj: ConfigResponse, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function ImageModelControl({ providers }: { providers: ProviderInfo[] }) {
  const [imageProvider, setImageProvider] = useState<ProviderInfo | null>(null);
  const [imageModel, setImageModel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const current = providers.find((p) => p.role === "image");
    if (current) {
      setImageProvider(current);
    }
  }, [providers]);

  async function handleSave() {
    if (!imageProvider) return;
    setSaving(true);
    try {
      await api.setProviderRole(imageProvider.name, "image", imageModel || undefined);
      toast.success(`Image provider set to ${imageProvider.label}${imageModel ? ` (${imageModel})` : ""}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set image provider");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Image Model</CardTitle>
        <CardDescription>
          Dedicated vision model for describing images. When set, all image content is sent to this provider
          for description before the main model processes the turn.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="mob-image-provider">Provider</Label>
          <Select value={imageProvider?.name ?? ""} onValueChange={(v) => {
            const p = providers.find((p) => p.name === v);
            setImageProvider(p ?? null);
            if (p) setImageModel("");
          }}>
            <SelectTrigger id="mob-image-provider">
              <SelectValue placeholder="Select image provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.label} ({p.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mob-image-model">Model (optional)</Label>
          <Input
            id="mob-image-model"
            value={imageModel}
            onChange={(e) => setImageModel(e.target.value)}
            placeholder="e.g. gpt-4o, claude-3-5-sonnet"
            spellCheck={false}
          />
        </div>
        <Button onClick={() => void handleSave()} disabled={saving || !imageProvider} className="w-full">
          <Save className="size-4" />
          {saving ? "Saving…" : "Save"}
        </Button>
        {imageProvider && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <span className="px-2 py-1 rounded bg-secondary text-secondary-foreground text-xs">Current: {imageProvider.label}</span>
            {imageModel && <span className="text-xs">Model: {imageModel}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ConfigView() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [formState, setFormState] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);

  useEffect(() => {
    api
      .getConfig()
      .then((res) => {
        setConfig(res);
        setRaw(JSON.stringify(res, null, 2));
        const state: Record<string, string> = {};
        for (const f of FIELDS) {
          const v = getPath(res, f.path);
          state[f.path] = f.type === "boolean" ? (v ? "true" : "false") : v == null ? "" : String(v);
        }
        setFormState(state);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load config"))
      .finally(() => setLoading(false));

    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
  }, []);

  const setField = (path: string, value: string) =>
    setFormState((prev) => ({ ...prev, [path]: value }));

  async function fetchModels() {
    const providerName = providers.find((p) => p.active)?.name;
    if (!providerName) {
      toast.error("No active provider");
      return;
    }
    try {
      const res = await api.providerModels(providerName);
      if (!res.models.length) {
        toast.warning(`No models on '${providerName}'`);
        return;
      }
      setModelSuggestions(res.models);
      setFormState((prev) => ({ ...prev, "agents.defaults.model": res.models[0] }));
      toast.success(`Found ${res.models.length} models`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch models");
    }
  }

  async function saveForm() {
    if (!config) return;
    setSaving(true);
    const payload: ConfigResponse = {};
    for (const f of FIELDS) {
      const v = formState[f.path];
      if (f.type === "boolean") {
        setPath(payload, f.path, v === "true");
      } else if (f.type === "number") {
        const n = Number(v);
        if (v !== "" && !Number.isNaN(n)) setPath(payload, f.path, n);
      } else {
        setPath(payload, f.path, v ?? "");
      }
    }
    try {
      const res = await api.putConfig(payload);
      setRestartRequired(res.restartRequired);
      toast.success(res.restartRequired ? "Saved — restart required" : "Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  async function saveRaw() {
    setSaving(true);
    try {
      const parsed = JSON.parse(raw) as ConfigResponse;
      const res = await api.putConfig(parsed);
      setRestartRequired(res.restartRequired);
      toast.success(res.restartRequired ? "Saved — restart required" : "Saved");
    } catch {
      toast.error("Invalid JSON or save failed");
    } finally {
      setSaving(false);
    }
  }

  async function restart() {
    setRestarting(true);
    try {
      await api.restart();
      toast.info("Restarting…");
      setRestartRequired(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restart");
    } finally {
      setRestarting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading config…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-config">
      <div className="border-b px-4 py-3">
        <h1 className="text-base font-semibold">Config</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {restartRequired && (
          <Button className="mb-3 w-full" variant="outline" onClick={() => void restart()} disabled={restarting}>
            <RotateCw className={restarting ? "animate-spin" : ""} />
            {restarting ? "Restarting…" : "Restart gateway"}
          </Button>
        )}

        <ImageModelControl providers={providers} />

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Settings</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => void saveRaw()} disabled={saving}>
              <Save className="size-4" />
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-2">
                  <Label>Model</Label>
                  <Input
                    list="mob-model-suggestions"
                    value={formState["agents.defaults.model"] ?? ""}
                    onChange={(e) => setField("agents.defaults.model", e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <Button variant="outline" size="icon" onClick={() => void fetchModels()} aria-label="Fetch models">
                  <RefreshCw />
                </Button>
              </div>
              {modelSuggestions.length > 0 && (
                <datalist id="mob-model-suggestions">
                  {modelSuggestions.map((mm) => (
                    <option key={mm} value={mm} />
                  ))}
                </datalist>
              )}
            </div>
            {FIELDS.filter((f) => f.id !== "model").map((f) =>
              f.type === "boolean" ? (
                <div key={f.id} className="flex items-center justify-between">
                  <Label>{f.label}</Label>
                  <Switch
                    checked={formState[f.path] === "true"}
                    onCheckedChange={(c) => setField(f.path, c ? "true" : "false")}
                  />
                </div>
              ) : (
                <div key={f.id} className="flex flex-col gap-2">
                  <Label>{f.label}</Label>
                  <Input
                    type={f.type === "number" ? "number" : "text"}
                    step={f.step}
                    value={formState[f.path] ?? ""}
                    onChange={(e) => setField(f.path, e.target.value)}
                    spellCheck={false}
                  />
                </div>
              ),
            )}
            <Button onClick={() => void saveForm()} disabled={saving}>
              <Save /> {saving ? "Saving…" : "Save"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Raw JSON</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              className="min-h-[240px] font-mono text-[13px]"
            />
            <Button onClick={() => void saveRaw()} disabled={saving}>
              <Save /> {saving ? "Saving…" : "Save JSON"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
