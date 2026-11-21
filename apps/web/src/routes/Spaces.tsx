import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { currentUser, request, send, type Space, type User, type Visibility } from "../lib/space-api";

export default function Spaces() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([request<{ spaces: Space[] }>("/api/spaces", { signal: controller.signal }), currentUser(controller.signal)])
      .then(([data, me]) => { setSpaces(data.spaces); setUser(me); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const units = String(form.get("units"));
    try {
      const { space } = await send<{ space: Space }>("/api/spaces", "POST", {
        name: form.get("name"), visibility: form.get("visibility") as Visibility,
        boundary: { coordinateSystem: { units, upAxis: "Y", calibrated: units === "metres" } },
      });
      navigate(`/spaces/${space.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-6 px-5 py-8">
    <header className="flex items-center justify-between"><Link to="/" className="font-display text-3xl font-black">!404</Link>
      {user ? <span>{user.displayName}</span> : <a href="/auth/login?returnTo=%2Fspaces" className="underline">Sign in to upload</a>}</header>
    <h1 className="text-2xl font-bold">3D spaces</h1>
    {loading && <p role="status">Loading spaces…</p>}
    {error && <p role="alert" className="text-rust">{error}</p>}
    <ul className="space-y-3">{spaces.map(space => <li key={space.id}><Link className="block rounded-xl bg-surface p-4 underline" to={`/spaces/${space.id}`}>{space.name}</Link></li>)}</ul>
    {!loading && !spaces.length && <p>No accessible spaces yet.</p>}
    {user && <form onSubmit={create} className="editor-grid rounded-xl bg-surface p-5">
      <h2 className="text-xl font-bold">Create a space</h2>
      <label>Name<input name="name" required maxLength={200} /></label>
      <label>Sharing<select name="visibility" defaultValue="private"><option value="private">Private</option><option value="public">Public — anyone with the link</option></select></label>
      <label>Coordinate units<select name="units" defaultValue="relative"><option value="relative">Relative — scale is unknown</option><option value="metres">Metres — I will calibrate every scan</option></select></label>
      <p className="text-sm text-muted">Choose the units before adding navigation nodes. Ordinary video reconstruction needs a measured distance to establish metres.</p>
      <button disabled={busy} className="action-button">{busy ? "Creating…" : "Create space"}</button>
    </form>}
  </main>;
}
