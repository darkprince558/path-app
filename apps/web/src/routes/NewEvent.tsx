import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { createEvent, useMyEvents } from "../lib/events";

const MAX_NAME = 200;

/** /events/new: name the event; maps and the invite link come next on its page. */
export default function NewEvent() {
  const navigate = useNavigate();
  const { reload } = useMyEvents();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { document.title = "Create event · Not 404"; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) { setError("Give the event a name."); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await createEvent({ name: cleanName, ...(description.trim() ? { description: description.trim() } : {}) });
      reload();
      navigate(`/events/${created.event.id}`, { state: { created: true } });
    } catch (cause) {
      setError(cause instanceof Error ? `Couldn't create the event. ${cause.message}` : "Couldn't create the event.");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <Link to="/events" className="text-sm font-bold text-rust underline underline-offset-4">← Events</Link>
      <h1 className="mt-4 font-display text-4xl leading-none font-black">Create event</h1>
      <p className="mt-3 text-lg text-muted">
        Next you'll add maps and get an invite link. Everyone who joins can open those maps and get directions.
      </p>
      <form onSubmit={submit} className="mt-8 grid gap-5">
        <div className="grid gap-2">
          <label htmlFor="event-name" className="font-bold">Name</label>
          <input id="event-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} required
            disabled={saving} placeholder="Hack Western 13" aria-describedby={error ? "event-error" : undefined}
            className="min-h-12 rounded-lg bg-surface px-3 text-lg ring-1 ring-forest/25" />
        </div>
        <div className="grid gap-2">
          <label htmlFor="event-description" className="font-bold">Description <span className="font-normal text-muted">(optional)</span></label>
          <textarea id="event-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000}
            disabled={saving} rows={3} placeholder="Where to go and what to find there"
            className="rounded-lg bg-surface px-3 py-2 ring-1 ring-forest/25" />
        </div>
        {error ? <p id="event-error" role="alert" className="text-rust">{error}</p> : null}
        <button type="submit" disabled={saving}
          className="min-h-14 rounded-full bg-coral px-6 text-lg font-bold text-ink disabled:bg-forest/15 disabled:text-forest/60">
          {saving ? "Creating…" : "Create event"}
        </button>
      </form>
    </div>
  );
}
