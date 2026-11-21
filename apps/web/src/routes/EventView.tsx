import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { request, type Space, type SavedPath } from "../lib/space-api";

export default function EventView() {
  const { eventId } = useParams();
  const [data, setData] = useState<{ event: { name: string }; spaces: Space[]; paths: SavedPath[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    request<NonNullable<typeof data>>(`/api/events/${encodeURIComponent(eventId ?? "")}`, { signal: controller.signal })
      .then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [eventId]);
  return <main className="mx-auto max-w-2xl space-y-5 p-6"><Link to="/spaces" className="underline">All spaces</Link>
    {error ? <p role="alert">This event is unavailable or private. {error}</p> : !data ? <p role="status">Opening event…</p> : <>
      <h1 className="text-2xl font-bold">{data.event.name}</h1>
      {data.spaces.map(space => <section className="rounded-xl bg-surface p-4" key={space.id}><Link className="text-lg font-bold underline" to={`/spaces/${space.id}`}>{space.name}</Link>
        <ul>{data.paths.filter(p => p.spaceId === space.id).map(path => <li key={path.id}><Link className="underline" to={`/spaces/${space.id}?path=${encodeURIComponent(path.id)}`}>{path.name}</Link></li>)}</ul>
      </section>)}
    </>}
  </main>;
}
