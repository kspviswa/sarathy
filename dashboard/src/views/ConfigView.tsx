import { Loader2, RefreshCw, RotateCw, Save } from "lucide-react";
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
  const [tab, setTab] = useState<"form" | "raw">("form");
  const [formState, setFormState] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

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

    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
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
          <Tabs value={tab} onValueChange={(v) => setTab(v as "form" | "raw")}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="raw">JSON</TabsTrigger>
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

function ProvidersManager({ onActiveChanged }: { onActiveChanged: (name: string) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [modelsFor, setModelsFor] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const refresh = () => {
    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load providers"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const openAdd = () => {
    setEditing(null);
    setForm({ kind: "custom", apiBase: "http://localhost:8000/v1", apiKey: "", label: "" });
  };

  const openEdit = (p: ProviderInfo) => {
    setEditing(p);
    setForm({
      name: p.name,
      kind: p.kind,
      apiBase: p.apiBase ?? "",
      apiKey: "",
      label: p.label,
    });
  };

  async function submit() {
    const name = (form.name ?? "").trim();
    if (!name) {
      toast.error("Provider name is required");
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = { apiBase: form.apiBase, label: form.label, kind: form.kind };
        if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
        await api.editProvider(editing.name, body);
        toast.success(`Provider '${editing.name}' updated`);
      } else {
        await api.addProvider({
          name,
          kind: form.kind,
          apiBase: form.apiBase,
          apiKey: form.apiKey.trim() || undefined,
          label: form.label || name,
        });
        toast.success(`Provider '${name}' added`);
      }
      setEditing(null);
      setForm({});
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: ProviderInfo) {
    if (!window.confirm(`Remove provider '${p.name}'?`)) return;
    setBusy(true);
    try {
      await api.removeProvider(p.name);
      toast.success(`Provider '${p.name}' removed`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider");
    } finally {
      setBusy(false);
    }
  }

  async function activate(p: ProviderInfo) {
    setBusy(true);
    try {
      const res = await api.setRuntime({ provider: p.name });
      if (res.applied) toast.success(`Active provider set to '${p.name}' (no restart)`);
      else toast.warning("Provider set — gateway restart required");
      refresh();
      onActiveChanged(p.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch provider");
    } finally {
      setBusy(false);
    }
  }

  async function showModels(p: ProviderInfo) {
    setModelsFor(p.name);
    setModels([]);
    try {
      const res = await api.providerModels(p.name);
      setModels(res.models);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to fetch models from '${p.name}'`);
      setModelsFor(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Providers</CardTitle>
          <CardDescription>LLM endpoints available to sarathy. Model/parameter changes apply without a restart.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={openAdd}>
          Add provider
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading providers…
          </div>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No providers configured.</p>
        ) : (
          <div className="flex flex-col divide-y">
            {providers.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {p.label}
                    {p.active ? (
                      <Badge variant="default" className="text-[10px]">
                        active
                      </Badge>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.name} · {p.kind} · {p.isLocal ? p.apiBase ?? "no endpoint" : p.hasApiKey ? "apiKey set" : "no apiKey"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {!p.active ? (
                    <Button size="sm" variant="outline" onClick={() => void activate(p)} disabled={busy}>
                      Activate
                    </Button>
                  ) : null}
                  {modelsFor === p.name ? (
                    <Button size="sm" variant="ghost" onClick={() => setModelsFor(null)}>
                      Hide
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void showModels(p)}>
                      Models
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove(p)} disabled={p.active || busy}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {modelsFor && modelsFor !== null && (
          <div className="rounded-md border p-3">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Models on {modelsFor}</p>
            {models.length ? (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                {models.map((m) => (
                  <li key={m} className="truncate">
                    • {m}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No models returned.</p>
            )}
          </div>
        )}

        {editing !== null || Object.keys(form).length > 0 ? (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="text-sm font-semibold">{editing ? `Edit ${editing.name}` : "Add provider"}</p>
            {!editing ? (
              <Input placeholder="name (e.g. my-openai)" value={form.name ?? ""} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={form.kind ?? "custom"} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger>
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
              <Input placeholder="API base URL" value={form.apiBase ?? ""} onChange={(e) => setForm((f) => ({ ...f, apiBase: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input placeholder="API key (leave blank to keep)" value={form.apiKey ?? ""} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
              <Input placeholder="Label" value={form.label ?? ""} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submit()} disabled={busy}>
                {editing ? "Save" : "Add"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setForm({}); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}