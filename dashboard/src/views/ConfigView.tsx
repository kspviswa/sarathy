import { Loader2, RotateCw, Save } from "lucide-react";
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
import type { ConfigResponse } from "@/lib/types";

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
  { id: "provider", path: "agents.defaults.provider", label: "Provider", type: "text" },
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
  }, []);

  const setField = (path: string, value: string) => setFormState((prev) => ({ ...prev, [path]: value }));

  async function saveForm() {
    if (!config) return;
    setSaving(true);
    const payload: ConfigResponse = {};
    for (const field of FIELDS) {
      const value = fromFormValue(formState[field.path] ?? "", field);
      if (value === undefined) continue;
      setPath(payload, field.path, value);
    }
    try {
      const res = await api.putConfig(payload);
      if (res.restartRequired) {
        setRestartRequired(true);
        toast.success("Config saved — restart required");
      } else {
        toast.success("Config saved");
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
                  {section.fields.map((field) => (
                    <FieldRow key={field.id} field={field} value={formState[field.path] ?? ""} onChange={(v) => setField(field.path, v)} />
                  ))}
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
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
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
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`f-${field.id}`}>{field.label}</Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={`f-${field.id}`}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((opt) => (
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