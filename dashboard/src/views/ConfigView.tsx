import { Loader2, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ConfigResponse } from "@/lib/types";

const FORM_ORDER = ["model", "provider", "apiKey", "temperature", "system_prompt", "streaming", "embeddingModel"];

const FIELD_META: Record<string, { label: string; type: "text" | "number" | "boolean" | "secret" }> = {
  model: { label: "Model", type: "text" },
  provider: { label: "Provider", type: "text" },
  apiKey: { label: "API key", type: "secret" },
  temperature: { label: "Temperature", type: "number" },
  system_prompt: { label: "System prompt", type: "text" },
  streaming: { label: "Streaming", type: "boolean" },
  embeddingModel: { label: "Embedding model", type: "text" },
};

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
        for (const key of FORM_ORDER) {
          const v = res[key];
          if (v === undefined) continue;
          state[key] = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
        }
        setFormState(state);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load config"))
      .finally(() => setLoading(false));
  }, []);

  const setField = (key: string, value: string) => setFormState((prev) => ({ ...prev, [key]: value }));

  async function saveForm() {
    setSaving(true);
    const payload: ConfigResponse = {};
    for (const key of FORM_ORDER) {
      const meta = FIELD_META[key];
      const v = formState[key];
      if (v === undefined) continue;
      if (meta?.type === "boolean") payload[key] = v === "true";
      else if (meta?.type === "number") {
        const n = Number(v);
        if (!Number.isNaN(n)) payload[key] = n;
      } else payload[key] = v;
    }
    try {
      const res = await api.putConfig(payload);
      if (res.restartRequired) {
        setRestartRequired(true);
        toast.success("Config saved — restart required");
      } else {
        toast.success("Config saved");
      }
      setRaw(JSON.stringify(payload, null, 2));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  async function saveRaw() {
    setSaving(true);
    try {
      const parsed = JSON.parse(raw);
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
            <TabsContent value="form" className="flex flex-col gap-4">
              {FORM_ORDER.filter((key) => config?.[key] !== undefined).map((key) => {
                const meta = FIELD_META[key];
                const v = formState[key];
                if (meta?.type === "boolean") {
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <Label htmlFor={`f-${key}`}>{meta.label}</Label>
                      <Switch
                        id={`f-${key}`}
                        checked={v === "true"}
                        onCheckedChange={(c) => setField(key, c ? "true" : "false")}
                      />
                    </div>
                  );
                }
                return (
                  <div key={key} className="flex flex-col gap-2">
                    <Label htmlFor={`f-${key}`}>{meta?.label ?? key}</Label>
                    <Input
                      id={`f-${key}`}
                      type={meta?.type === "secret" ? "password" : meta?.type === "number" ? "number" : "text"}
                      value={v ?? ""}
                      onChange={(e) => setField(key, e.target.value)}
                      placeholder={meta?.type === "secret" ? "<set>" : undefined}
                    />
                  </div>
                );
              })}
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