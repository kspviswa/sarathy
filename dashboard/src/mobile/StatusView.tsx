import { StatusPanel } from "@/components/StatusPanel";

/**
 * Status is no longer a destination of its own — it is the Status segment of
 * the Settings surface (spec §B). This wrapper keeps the old import working
 * for anything that still reaches for it.
 */
export function StatusView({ onLoggedOut }: { onLoggedOut: () => void }) {
  return <StatusPanel onLoggedOut={onLoggedOut} variant="mobile" />;
}

export default StatusView;
