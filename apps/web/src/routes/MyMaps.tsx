import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import MapCard from "../components/MapCard";
import { filterMaps, MAP_FILTERS, SAMPLE_MAPS, type MapFilter } from "../lib/maps";

export default function MyMaps() {
  const [filter, setFilter] = useState<MapFilter>("all");
  const maps = filterMaps(SAMPLE_MAPS, filter);

  useEffect(() => {
    document.title = "Your maps · Path";
  }, []);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-4">
        <h1 className="font-display text-4xl leading-none font-black">Your maps</h1>
        <Link
          to="/maps/new"
          className="hidden min-h-11 items-center gap-2 rounded-full bg-coral px-5 font-bold text-ink md:inline-flex"
        >
          <Plus className="size-5" aria-hidden />
          New map
        </Link>
      </div>

      <div
        role="group"
        aria-label="Filter maps"
        className="-mx-4 mt-6 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0"
      >
        {MAP_FILTERS.map(({ value, label }) => {
          const active = value === filter;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(value)}
              className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-bold whitespace-nowrap transition-colors ${
                active ? "bg-forest text-paper" : "bg-surface text-forest ring-1 ring-forest/20 hover:ring-forest/50"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <p className="mt-4 rounded-lg bg-surface px-3 py-2 text-sm text-muted ring-1 ring-forest/10">
        These are <strong className="text-forest">sample maps</strong>. Your own uploads will show here once the
        server can list them.
      </p>

      {maps.length ? (
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-5 xl:grid-cols-4">
          {maps.map((map) => (
            <li key={map.id}>
              <MapCard map={map} sample />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-10 text-center text-muted">No maps match this filter yet.</p>
      )}
    </div>
  );
}
