import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { relative } from "../lib/dates";

/**
 * Shows when calendar data last refreshed and whether the connection is failing.
 * Queries poll every 20 s while the tab is visible and retry with backoff when offline.
 */
export function SyncStatus({ lastSync, failing }: { lastSync: number | null; failing: boolean }) {
  const fetching = useIsFetching() > 0;
  const qc = useQueryClient();
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => {
      setOnline(true);
      void qc.invalidateQueries();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      clearInterval(t);
    };
  }, [qc]);

  if (!online || failing) {
    return (
      <span className="sync sync-bad" role="status">
        <CloudOff size={14} aria-hidden /> {online ? "Can't reach server — retrying" : "Offline — showing last loaded data"}
      </span>
    );
  }
  return (
    <span className="sync" role="status" aria-live="polite">
      <RefreshCw size={14} className={fetching ? "spin" : undefined} aria-hidden />
      {fetching ? "Updating…" : lastSync ? `Updated ${relative(new Date(lastSync).toISOString())}` : "Live"}
    </span>
  );
}
