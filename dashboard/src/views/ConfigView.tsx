import { SettingsView } from "@/views/SettingsView";

/**
 * Config is no longer a destination of its own — it is the Form segment of
 * the Settings surface (spec §B). This wrapper keeps the old import working
 * for anything that still reaches for it.
 */
export function ConfigView() {
  return <SettingsView variant="desktop" onLoggedOut={() => {}} />;
}

export default ConfigView;
