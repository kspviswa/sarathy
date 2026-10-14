import { Check, Loader2, RefreshCw, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DevicesPanel } from "@/components/DevicesPanel";
import { api } from "@/lib/api";
import type { ConfigResponse, ProviderInfo } from "@/lib/types";

type FieldType = "text" | "number" | "boolean" | "select";

interface FieldDef {
  id: string;
  path: string;
  label: string;
  type: FieldType;
  step?: number;
  options?: string[];
}

const FIELDS: FieldDef[] = [
  { id: "model", path: "agents.defaults.model", label: "Model", type: "text" },
  { id: "provider", path: "agents.defaults.provider", label: "Provider", type: "select" },
  { id: "temperature", path: "agents.defaults.temperature", label: "Temperature", type: "number", step: 0.1 },
  { id: "maxTokens", path: "agents.defaults.maxTokens", label: "Max tokens", type: "number" },
  { id: "contextLength", path: "agents.defaults.contextLength", label: "Context length", type: "number" },
  { id: "workspace", path: "agents.defaults.workspace", label: "Workspace", type: "text" },
  {
    id: "reasoningEffort",
    path: "agents.defaults.reasoningEffort",
    label: "Reasoning effort",
    type: "select",
    options: ["", "off", "low", "medium", "high", "xhigh"],
  },
  { id: "sendProgress", path: "channels.sendProgress", label: "Stream progress messages", type: "boolean" },
  { id: "sendToolHints", path: "channels.sendToolHints", label: "Stream tool-call hints", type: "boolean" },
  { id: "dashStreaming", path: "channels.dashboard.streaming", label: "Dashboard streaming", type: "boolean" },
  { id: "dashHost", path: "channels.dashboard.host", label: "Dashboard host", type: "text" },
  { id: "dashPort", path: "channels.dashboard.port", label: "Dashboard port", type: "number" },
];

const RUNTIME_PATHS = new Set([
  "agents.defaults.model",
  "agents.defaults.provider",
  "agents.defaults.temperature",
  "agents.defaults.maxTokens",
  "agents.defaults.reasoningEffort",
]);

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  { title: "Agent", fields: FIELDS.slice(0, 7) },
  { title: "Channels", fields: FIELDS.slice(7, 9) },
  { title: "Dashboard", fields: FIELDS.slice(9) },
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

function toFormValue(v: unknown, type: FieldType): string {
  if (v === undefined || v === null) return type === "select" ? "" : "";
  if (type === "boolean") return v ? "true" : "false";
  return String(v);
}

function fromFormValue(v: string, field: FieldDef): unknown {
  if (field.type === "boolean") return v === "true";
  if (field.type === "number") {
    if (v === "") return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  if (field.type === "select") {
    if (v === "") return null;
    if (v === "off" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
    return v;
  }
  return v;
}

export function ConfigView() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tab, setTab] = useState<"form" | "raw" | "devices">("form");
  const [formState, setFormState] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const reloadProviders = () => {
    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
  };

  useEffect(() => {
    api
      .getConfig()
      .then((res) => {
        setConfig(res);
        setRaw(JSON.stringify(res, null, 2));
        const state: Record<string, string> = {};
        for (const field of FIELDS) {
          state[field.path] = toFormValue(getPath(res, field.path), field.type);
        }
        setFormState(state);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load config"))
      .finally(() => setLoading(false));

    reloadProviders();
  }, []);

  const setField = (path: string, value: string) => {
    setFormState((prev) => ({ ...prev, [path]: value }));
    if (path === "agents.defaults.provider") setModelSuggestions([]);
  };

  async function fetchModels() {
    const providerName = formState["agents.defaults.provider"] ?? "";
    if (!providerName) {
      toast.error("Select a provider first");
      return;
    }
    setFetchingModels(true);
    try {
      const res = await api.providerModels(providerName);
      if (!res.models.length) {
        toast.warning(`No models returned by '${providerName}'`);
        setModelSuggestions([]);
        return;
      }
      setModelSuggestions(res.models);
      setFormState((prev) => ({ ...prev, "agents.defaults.model": res.models[0] }));
      toast.success(`Found ${res.models.length} models on '${providerName}'`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch models");
    } finally {
      setFetchingModels(false);
    }
  }

  async function saveForm() {
    if (!config) return;
    setSaving(true);
    const payload: ConfigResponse = {};
    const runtimeChanges: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const value = fromFormValue(formState[field.path] ?? "", field);
      if (value === undefined) continue;
      setPath(payload, field.path, value);
      if (RUNTIME_PATHS.has(field.path)) runtimeChanges[field.path.split(".").pop() as string] = value;
    }
    try {
      await api.putConfig(payload);
      if (Object.keys(runtimeChanges).length > 0) {
        const res = await api.setRuntime({
          provider: runtimeChanges.provider as string | undefined,
          model: runtimeChanges.model as string | undefined,
        });
        if (res.applied) {
          setRestartRequired(false);
          toast.success("Config saved — model/params applied without restart");
        } else {
          setRestartRequired(true);
          toast.warning("Config saved — restart required to apply model/params");
        }
      } else {
        setRestartRequired(true);
        toast.success("Config saved — restart required");
      }
      const merged = structuredClone(config);
      for (const field of FIELDS) {
        const value = fromFormValue(formState[field.path] ?? "", field);
        if (value === undefined) continue;
        setPath(merged, field.path, value);
      }
      setRaw(JSON.stringify(merged, null, 2));
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
      if (res.restartRequired) {
        setRestartRequired(true);
        toast.success("Config saved — restart required");
      } else {
        toast.success("Config saved");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid JSON or save failed");
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
        <Loader2 className="size-4 animate-spin" />
        Loading config…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <ProvidersManager
        onActiveChanged={(name) => {
          setFormState((prev) => ({ ...prev, "agents.defaults.provider": name }));
          setModelSuggestions([]);
        }}
      />
      {restartRequired ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              <Badge variant="default" className="mr-2">
                Restart required
              </Badge>
              Restart the gateway to apply changes.
            </p>
            <Button onClick={() => void restart()} disabled={restarting}>
              <RotateCw className={restarting ? "animate-spin" : ""} />
              {restarting ? "Restarting…" : "Restart gateway"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Edit Sarathy configuration. Secrets show as placeholder values.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={(v) => setTab(v as "form" | "raw" | "devices")}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="raw">JSON</TabsTrigger>
              <TabsTrigger value="devices">Devices</TabsTrigger>
            </TabsList>
            <TabsContent value="form" className="flex flex-col gap-6">
              {SECTIONS.map((section) => (
                <div key={section.title} className="flex flex-col gap-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {section.title}
                  </p>
                  {section.fields.map((field) => {
                    if (field.id === "model") {
                      return (
                        <div key={field.id} className="flex flex-col gap-2">
                          <div className="flex items-end gap-2">
                            <div className="flex flex-1 flex-col gap-2">
                              <Label htmlFor={`f-${field.id}`}>{field.label}</Label>
                              <Input
                                id={`f-${field.id}`}
                                list="model-suggestions"
                                value={formState[field.path] ?? ""}
                                onChange={(e) => setField(field.path, e.target.value)}
                                spellCheck={false}
                                placeholder="e.g. llama3"
                              />
                            </div>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => void fetchModels()}
                              disabled={fetchingModels}
                              title="Fetch models from the selected provider"
                            >
                              <RefreshCw className={fetchingModels ? "animate-spin" : ""} />
                            </Button>
                          </div>
                          {modelSuggestions.length > 0 && (
                            <datalist id="model-suggestions">
                              {modelSuggestions.map((m) => (
                                <option key={m} value={m} />
                              ))}
                            </datalist>
                          )}
                        </div>
                      );
                    }
                    return (
                      <FieldRow
                        key={field.id}
                        field={field}
                        value={formState[field.path] ?? ""}
                        onChange={(v) => setField(field.path, v)}
                        providerOptions={providers.map((p) => p.name)}
                      />
                    );
                  })}
                </div>
              ))}
              <Button onClick={() => void saveForm()} disabled={saving}>
                <Save />
                {saving ? "Saving…" : "Save"}
              </Button>
            </TabsContent>
            <TabsContent value="raw" className="flex flex-col gap-3">
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                spellCheck={false}
                className="min-h-[320px] flex-1 font-mono text-[13px]"
              />
              <div className="flex gap-2">
                <Button onClick={() => void saveRaw()} disabled={saving}>
                  <Save />
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="devices">
              <DevicesPanel />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
  providerOptions = [],
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  providerOptions?: string[];
}) {
  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between">
        <Label htmlFor={`f-${field.id}`}>{field.label}</Label>
        <Switch id={`f-${field.id}`} checked={value === "true"} onCheckedChange={(c) => onChange(c ? "true" : "false")} />
      </div>
    );
  }
  if (field.type === "select") {
    const options = field.id === "provider" && providerOptions.length ? providerOptions : (field.options ?? []);
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`f-${field.id}`}>{field.label}</Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={`f-${field.id}`}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt === "" ? "None" : opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`f-${field.id}`}>{field.label}</Label>
      <Input
        id={`f-${field.id}`}
        type={field.type === "number" ? "number" : "text"}
        step={field.step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

const KINDS = ["custom", "ollama", "lmstudio", "vllm", "litellm"] as const;

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "No role" },
  { value: "main", label: "Main — default voice" },
  { value: "local", label: "Local — /local & async" },
  { value: "image", label: "Image — vision" },
];

function roleBadge(role: string): { label: string; variant: "default" | "secondary" | "outline" } | null {
  switch (role) {
    case "main":
      return { label: "main", variant: "default" };
    case "local":
      return { label: "local", variant: "secondary" };
    case "image":
      return { label: "image", variant: "outline" };
    default:
      return null;
  }
}

function ProviderCard({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const [role, setRole] = useState(provider.role || "none");
  const [model, setModel] = useState(provider.model || "");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => setRole(provider.role || "none"), [provider.role]);
  useEffect(() => setModel(provider.model || ""), [provider.model]);

  const datalistId = `models-${provider.name}`;
  const badge = roleBadge(provider.role);

  async function applyRole(next: string) {
    setRole(next);
    setRoleBusy(true);
    try {
      await api.setProviderRole(provider.name, next === "none" ? "" : next);
      toast.success(
        next === "none" ? `Cleared the role on ${provider.label}` : `${provider.label} set as ${next}`,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set role");
      setRole(provider.role || "none");
    } finally {
      setRoleBusy(false);
    }
  }

  async function loadModels() {
    setLoadingModels(true);
    try {
      const res = await api.providerModels(provider.name);
      setModels(res.models);
      if (!res.models.length) toast.warning(`No models returned by '${provider.name}'`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to fetch models from '${provider.name}'`);
    } finally {
      setLoadingModels(false);
    }
  }

  async function saveModel() {
    setBusy(true);
    try {
      const value = model.trim();
      await api.setProviderModel(provider.name, value);
      toast.success(
        value ? `Model for ${provider.label} set to ${value}` : `Model override cleared for ${provider.label}`,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set model");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove provider '${provider.name}'?`)) return;
    setBusy(true);
    try {
      await api.removeProvider(provider.name);
      toast.success(`Provider '${provider.name}' removed`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider");
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        apiBase: form.apiBase ?? "",
        label: form.label ?? "",
        kind: form.kind ?? provider.kind,
      };
      if ((form.apiKey ?? "").trim()) body.apiKey = (form.apiKey ?? "").trim();
      await api.editProvider(provider.name, body);
      toast.success(`Provider '${provider.name}' updated`);
      setEditing(false);
      setForm({});
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {provider.label}
            {provider.active ? (
              <Badge variant="outline" className="text-[10px]">
                active
              </Badge>
            ) : null}
            {badge ? (
              <Badge variant={badge.variant} className="text-[10px]">
                {badge.label}
              </Badge>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {provider.name} · {provider.kind} · {provider.apiBase ?? "no endpoint"}
            {provider.hasApiKey ? " · apiKey set" : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={() => {
            setEditing((v) => !v);
            setForm({ kind: provider.kind, apiBase: provider.apiBase ?? "", apiKey: "", label: provider.label });
          }}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => void remove()}
            disabled={provider.active || busy}
          >
            Remove
          </Button>
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={form.kind ?? provider.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
              <SelectTrigger className="sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="API base URL"
              value={form.apiBase ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, apiBase: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="API key (leave blank to keep)"
              value={form.apiKey ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            />
            <Input
              placeholder="Label"
              value={form.label ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void submitEdit()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setForm({}); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`role-${provider.name}`}>Role</Label>
          <Select value={role} onValueChange={(v) => void applyRole(v)} disabled={roleBusy}>
            <SelectTrigger id={`role-${provider.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`model-${provider.name}`}>Model</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`model-${provider.name}`}
              list={datalistId}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="provider default"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => void loadModels()}
              disabled={loadingModels}
              title="List models from this provider"
            >
              <RefreshCw className={loadingModels ? "animate-spin" : ""} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void saveModel()}
              disabled={busy}
              title="Save model for this provider"
            >
              <Check />
            </Button>
          </div>
          {models.length > 0 && (
            <datalist id={datalistId}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </div>
      </div>
    </div>
  );
}

function ProvidersManager({ onActiveChanged }: { onActiveChanged: (name: string) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api
      .providers()
      .then((res) => {
        setProviders(res.providers);
        const active = res.providers.find((p) => p.active);
        if (active) onActiveChanged(active.name);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load providers"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setAdding(true);
    setForm({ kind: "custom", apiBase: "", apiKey: "", label: "" });
  };

  async function submitAdd() {
    const name = (form.name ?? "").trim();
    if (!name) {
      toast.error("Provider name is required");
      return;
    }
    setBusy(true);
    try {
      await api.addProvider({
        name,
        kind: form.kind ?? "custom",
        apiBase: form.apiBase ?? "",
        apiKey: (form.apiKey ?? "").trim() || undefined,
        label: (form.label ?? "").trim() || name,
      });
      toast.success(`Provider '${name}' added`);
      setAdding(false);
      setForm({});
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Add an endpoint, list its models, pick a model, and tag it main / local / image.
            Tagging is independent of model choice.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={openAdd}>
          Add provider
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {adding ? (
          <div className="flex flex-col gap-3 rounded-md border border-primary/40 p-3">
            <p className="text-sm font-semibold">Add provider</p>
            <Input
              placeholder="name (e.g. my-lms)"
              value={form.name ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={form.kind ?? "custom"} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger className="sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="API base URL (e.g. http://localhost:1234/v1)"
                value={form.apiBase ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, apiBase: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="API key (optional)"
                value={form.apiKey ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
              <Input
                placeholder="Label (optional)"
                value={form.label ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submitAdd()} disabled={busy}>
                {busy ? "Adding…" : "Add"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setForm({}); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading providers…
          </div>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No providers configured.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {providers.map((p) => (
              <ProviderCard key={p.name} provider={p} onChanged={refresh} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
