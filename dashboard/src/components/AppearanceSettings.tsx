import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FONT_FACE_DEFAULT,
  applyAppearanceFonts,
  loadFontFamilies,
  readAppFont,
  readComposedFont,
  writeAppFont,
  writeComposedFont,
  type FontListSource,
} from "@/lib/appearanceFonts";

const DEFAULT_OPTION = "__default__";

/**
 * Settings → Appearance (spec 176 §C).
 *
 * Two independent font-face pickers. The list is loaded from the OS via
 * `queryLocalFonts()` on an explicit gesture; otherwise a documented web-safe
 * fallback is shown with an honest note.
 */
export function AppearanceSettings() {
  const [appFont, setAppFont] = useState(() => readAppFont());
  const [composedFont, setComposedFont] = useState(() => readComposedFont());
  const [families, setFamilies] = useState<string[]>([]);
  const [source, setSource] = useState<FontListSource | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    applyAppearanceFonts(appFont, composedFont);
  }, [appFont, composedFont]);

  const persistApp = useCallback((family: string) => {
    const next = family === DEFAULT_OPTION ? FONT_FACE_DEFAULT : family;
    setAppFont(next);
    writeAppFont(next);
    applyAppearanceFonts(next, readComposedFont());
  }, []);

  const persistComposed = useCallback((family: string) => {
    const next = family === DEFAULT_OPTION ? FONT_FACE_DEFAULT : family;
    setComposedFont(next);
    writeComposedFont(next);
    applyAppearanceFonts(readAppFont(), next);
  }, []);

  const loadFonts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadFontFamilies();
      setFamilies(result.families);
      setSource(result.source);
      setNote(result.note);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectValue = (family: string) =>
    family ? family : DEFAULT_OPTION;

  return (
    <div className="flex flex-col gap-4" data-testid="settings-appearance">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Choose fonts for the app chrome and for composed / generated text.
            System fonts load on demand — not a hardcoded shortlist.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadFonts()}
              disabled={loading}
              data-testid="appearance-load-fonts"
            >
              {loading ? "Loading fonts…" : "Load system fonts"}
            </Button>
            {source === "fallback" && note ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="appearance-fallback-note"
                role="status"
              >
                {note}
              </p>
            ) : null}
            {source === "system" ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="appearance-system-note"
                role="status"
              >
                {families.length} font families from this device.
              </p>
            ) : null}
            {source == null ? (
              <p className="text-xs text-muted-foreground" data-testid="appearance-idle-note">
                Press “Load system fonts” to populate the pickers from fonts
                installed on this machine.
              </p>
            ) : null}
          </div>

          <FontFaceField
            id="app-font"
            label="App font"
            description="Navigation, headers, panels, settings, and lists."
            value={selectValue(appFont)}
            families={familiesWith(families, appFont)}
            onChange={persistApp}
            previewText="Sarathy · Settings · Sessions · Jobs"
            testId="appearance-app-font"
          />

          <FontFaceField
            id="composed-font"
            label="Composed / generated text"
            description="Composer, preview, and conversation bubbles (chat + ask)."
            value={selectValue(composedFont)}
            families={familiesWith(families, composedFont)}
            onChange={persistComposed}
            previewText="The quick brown fox jumps over the lazy dog."
            testId="appearance-composed-font"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function familiesWith(families: string[], current: string): string[] {
  if (!current || families.includes(current)) return families;
  return [current, ...families];
}

function FontFaceField({
  id,
  label,
  description,
  value,
  families,
  onChange,
  previewText,
  testId,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  families: string[];
  onChange: (family: string) => void;
  previewText: string;
  testId: string;
}) {
  const previewFamily =
    value === DEFAULT_OPTION ? undefined : value || undefined;

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={`${testId}-trigger`}>
          <SelectValue placeholder="Default" />
        </SelectTrigger>
        <SelectContent data-testid={`${testId}-list`}>
          <SelectItem value={DEFAULT_OPTION} data-testid={`${testId}-default`}>
            Default
          </SelectItem>
          {families.map((family) => (
            <SelectItem
              key={family}
              value={family}
              data-testid={`${testId}-option`}
              style={{ fontFamily: family }}
            >
              {family}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm"
        data-testid={`${testId}-preview`}
        style={previewFamily ? { fontFamily: previewFamily } : undefined}
      >
        {previewText}
      </p>
    </div>
  );
}

export default AppearanceSettings;
