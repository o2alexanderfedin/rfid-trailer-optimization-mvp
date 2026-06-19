import { useEffect, useState } from "react";
import { SkeletonMap } from "./SkeletonMap.js";
import { fetchHubs, type HubDto } from "./hubs.js";

export function App() {
  const [hubs, setHubs] = useState<readonly HubDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHubs(controller.signal)
      .then(setHubs)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        Middle-Mile Live Map — {hubs.length} hub{hubs.length === 1 ? "" : "s"}
        {error !== null ? ` (error: ${error})` : ""}
      </header>
      <SkeletonMap hubs={hubs} />
    </div>
  );
}
