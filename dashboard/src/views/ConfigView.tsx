import {
  Bot,
  Cpu,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DevicesPanel } from "@/components/DevicesPanel";
import { api } from "@/lib/api";
import type { ConfigResponse, ModalitiesResponse, ModalityRole, ProviderInfo } from "@/lib/types";

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
  if (v === undefined || v === null) return "";
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
    return v;
  }
  return v;
}

const MODALITIES: {
  role: ModalityRole;
  label: string;
  blurb: string;
  Icon: typeof Bot;
  tint: string;
}[] = [
  {
    role: "main",
    label: "Main",
    blurb: "Sarathy's own voice — chat, voice notes and interactive turns.",
    Icon: Bot,
    tint: "text-violet-500",
  },
  {
    role: "local",
    label: "Local",
    blurb: "Backs /local and cheap async side turns on your own hardware.",
    Icon: Cpu,
    tint: "text-emerald-500",
  },
  {
    role: "image",
    label: "Image",
    blurb: "Vision — describes pictures before the main model sees them.",
    Icon: ImageIcon,
    tint: "text-sky-500",
  },
];

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
  const [modalities, setModalities] = useState<ModalitiesResponse | null>(null);
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const reloadProviders = useCallback(async () => {
    const [p, m] = await Promise.all([
      api.providers().catch(() => ({ providers: [], active: "" })),
      api.modalities().catch(() => null),
    ]);
    setProviders(p.providers);
    if (m) setModalities(m);
  }, []);

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

    void reloadProviders();
  }, [reloadProviders]);

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
      <ProvidersSection providers={providers} reload={reloadProviders} />

      <ModalitiesSection
        providers={providers}
        modalities={modalities}
        reload={reloadProviders}
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

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const KINDS = ["custom", "ollama", "lmstudio", "vllm", "litellm"] as const;
const v1Ok = (base: string) => base.trim().replace(/\/+$/, "").endsWith("/v1");

function ProvidersSection({
  providers,
  reload,
}: {
  providers: ProviderInfo[];
  reload: () => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [form, setForm] = useState({ name: "", kind: "custom", apiBase: "", apiKey: "" });
  const [busy, setBusy] = useState(false);

  const openAdd = () => {
    setEditing(null);
    setForm({ name: "", kind: "custom", apiBase: "", apiKey: "" });
    setDialogOpen(true);
  };

  const openEdit = (p: ProviderInfo) => {
    setEditing(p);
    setForm({ name: p.label, kind: p.kind, apiBase: p.apiBase ?? "", apiKey: "" });
    setDialogOpen(true);
  };

  const baseError =
    form.apiBase && !v1Ok(form.apiBase) ? "Base URL must end with /v1" : !form.apiBase ? "Base URL is required" : "";
  const canSubmit = !!form.name.trim() && !baseError && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          apiBase: form.apiBase.trim(),
          label: form.name.trim(),
          kind: form.kind,
        };
        if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
        await api.editProvider(editing.name, body);
        toast.success(`“${form.name.trim()}” updated`);
      } else {
        const res = await api.addProvider({
          label: form.name.trim(),
          kind: form.kind,
          apiBase: form.apiBase.trim(),
          apiKey: form.apiKey.trim() || undefined,
        });
        toast.success(`“${form.name.trim()}” added`);
        void res;
      }
      setDialogOpen(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: ProviderInfo) {
    if (!window.confirm(`Remove “${p.label}”?`)) return;
    try {
      await api.removeProvider(p.name);
      toast.success(`“${p.label}” removed`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Providers</CardTitle>
          <CardDescription>Endpoints Sarathy can talk to — any number, any mix.</CardDescription>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus />
          Add provider
        </Button>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No providers configured yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((p) => (
              <div key={p.name} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{p.label}</span>
                      {p.roles.map((r) => (
                        <Badge key={r} variant={r === "main" ? "default" : "secondary"} className="text-[10px]">
                          {r}
                        </Badge>
                      ))}
                    </p>
                    <p className="truncate text-xs capitalize text-muted-foreground">{p.kind}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => openEdit(p)} title="Edit">
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      onClick={() => void remove(p)}
                      disabled={p.roles.includes("main")}
                      title={p.roles.includes("main") ? "Cannot remove the main provider" : "Remove"}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="truncate text-xs text-muted-foreground" title={p.apiBase ?? ""}>
                  {p.apiBase ?? "no endpoint"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.hasApiKey ? "API key set" : "no API key"}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit provider" : "Add provider"}</DialogTitle>
            <DialogDescription>
              Give it any name you like — add as many as you need, even several of the same kind.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="pv-name">Name</Label>
              <Input
                id="pv-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ollama S1"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pv-kind">Type</Label>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger id="pv-kind">
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
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pv-base">Base URL</Label>
              <Input
                id="pv-base"
                value={form.apiBase}
                onChange={(e) => setForm((f) => ({ ...f, apiBase: e.target.value }))}
                placeholder="http://192.168.0.18:1234/v1"
                spellCheck={false}
              />
              {baseError ? <p className="text-xs text-destructive">{baseError}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pv-key">API key</Label>
              <Input
                id="pv-key"
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={editing?.hasApiKey ? "•••••• (leave blank to keep)" : "dummy"}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">Optional — use “dummy” for local servers.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Modalities
// ---------------------------------------------------------------------------

function ModalitiesSection({
  providers,
  modalities,
  reload,
}: {
  providers: ProviderInfo[];
  modalities: ModalitiesResponse | null;
  reload: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Modalities</CardTitle>
        <CardDescription>
          Pick a provider and a model for each role. Any pairing can be reused across roles.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {MODALITIES.map((m) => (
          <ModalityCard
            key={m.role}
            role={m.role}
            label={m.label}
            blurb={m.blurb}
            Icon={m.Icon}
            tint={m.tint}
            providers={providers}
            binding={modalities ? modalities[m.role] : null}
            reload={reload}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ModalityCard({
  role,
  label,
  blurb,
  Icon,
  tint,
  providers,
  binding,
  reload,
}: {
  role: ModalityRole;
  label: string;
  blurb: string;
  Icon: typeof Bot;
  tint: string;
  providers: ProviderInfo[];
  binding: { provider: string | null; model: string | null } | null;
  reload: () => Promise<void>;
}) {
  const providerName = binding?.provider ?? "";
  const model = binding?.model ?? "";
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadModels = useCallback(async (name: string) => {
    if (!name) return;
    setLoading(true);
    setError(false);
    try {
      const res = await api.providerModels(name);
      setModels(res.models);
    } catch {
      setModels([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (providerName) void loadModels(providerName);
    else setModels([]);
  }, [providerName, loadModels]);

  async function save(nextProvider: string, nextModel: string) {
    setBusy(true);
    try {
      await api.setModality(role, nextProvider, nextModel);
      await reload();
      if (nextProvider && nextModel) toast.success(`${label} → ${nextProvider}/${nextModel}`);
      else if (nextProvider) toast.success(`${label} → ${nextProvider}`);
      else toast.success(`${label} cleared`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to update ${label}`);
    } finally {
      setBusy(false);
    }
  }

  const providerOptions: ComboboxOption[] = providers.map((p) => ({
    value: p.name,
    label: p.label,
    hint: p.roles.length ? p.roles.join(", ") : undefined,
  }));

  const modelOptions: ComboboxOption[] = [];
  if (model && !models.includes(model)) modelOptions.push({ value: model, label: model, hint: "current" });
  for (const m of models) modelOptions.push({ value: m, label: m });

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-3 flex items-start gap-3">
        <div className={`mt-0.5 ${tint}`}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {label}
            {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          </p>
          <p className="text-xs text-muted-foreground">{blurb}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Provider</Label>
          <Combobox
            value={providerName}
            onChange={(v) => void save(v, "")}
            options={providerOptions}
            placeholder="Select provider…"
            searchPlaceholder="Search providers…"
            emptyText="No providers configured."
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Model</Label>
          {error ? (
            <div className="flex items-center gap-2">
              <Input
                value={model}
                onChange={(e) => void save(providerName, e.target.value)}
                placeholder="Type a model id"
                spellCheck={false}
              />
            </div>
          ) : (
            <Combobox
              value={model}
              onChange={(v) => void save(providerName, v)}
              options={modelOptions}
              placeholder={providerName ? "Select model…" : "Pick a provider first"}
              searchPlaceholder="Search models…"
              emptyText={providerName ? "No models — check the endpoint." : "Pick a provider first"}
              disabled={!providerName}
              loading={loading}
            />
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Using{" "}
          <code className="rounded bg-muted px-1">
            {providerName ? `${providerName}/${model || "—"}` : "not configured"}
          </code>
        </p>
        {providerName && !error ? (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => void loadModels(providerName)}
          >
            {models.length ? `${models.length} models — refresh` : "refresh models"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
