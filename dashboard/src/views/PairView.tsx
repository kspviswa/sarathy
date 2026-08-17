import { KeyRound, Loader2, Smartphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, setToken } from "@/lib/api";

export function PairView({ onPaired }: { onPaired: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  async function handlePair(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    try {
      const res = await api.pair(key.trim(), name.trim() || "my device");
      setToken(res.token);
      onPaired();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="safe-top flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo size={56} />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sarathy</h1>
          <p className="text-sm text-muted-foreground">Pair this device with your assistant</p>
        </div>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4 text-primary" />
            Pair a device
          </CardTitle>
          <CardDescription>
            Enter the pairing key generated on your machine with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">sarathy dashboard start</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePair} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="key">Pairing key</Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sara-xxxx-xxxx-xxxx-xxxx"
                  className="pl-9 font-mono"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Device name (optional)</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My iPhone"
              />
            </div>
            <Button type="submit" size="lg" disabled={loading || !key.trim()}>
              {loading ? <Loader2 className="animate-spin" /> : null}
              {loading ? "Pairing…" : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}