import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { shareUrl, updateSharing, UploadError, type Visibility } from "../lib/scans";
import VisibilityPicker, { visibilityDetail, visibilityLabel } from "./VisibilityPicker";

const FOREST = "#2F4A3A";
const SURFACE = "#FAF5E6";

function isLocalHost(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

export default function SharePanel({
  mapId,
  sharePath,
  initialVisibility,
  viewers = [],
  heading = "Your link is ready",
  footer,
}: {
  /** The ID edit calls take (mapEditId). */
  mapId: string;
  sharePath: string;
  initialVisibility: Visibility;
  /**
   * Names of people already added to a private map. Shown, not edited: adding and removing
   * people waits for a proper people picker after the demo.
   */
  viewers?: string[];
  heading?: string;
  /** Extra actions under the sharing controls, e.g. "Upload another scan". */
  footer?: ReactNode;
}) {
  const url = shareUrl(sharePath);
  const [saved, setSaved] = useState(initialVisibility);
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const dirty = visibility !== saved;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard API blocked (e.g. insecure origin): select the text so a long-press copy works.
      urlRef.current?.select();
      setMessage({ tone: "error", text: "Couldn't copy automatically. The link is selected, so copy it from there." });
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const result = await updateSharing(mapId, visibility);
      setSaved(result.visibility);
      const who =
        result.visibility === "private"
          ? viewers.length
            ? ` You and ${viewers.join(", ")} can open it.`
            : " Only you can open it."
          : "";
      setMessage({ tone: "ok", text: `Saved. This map is now ${visibilityLabel(result.visibility)}.${who}` });
      toast.success(`Now ${visibilityLabel(result.visibility)}`);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof UploadError ? error.message : "Couldn't save that change." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="share-title" className="grid gap-6">
      <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-forest/10">
        <h2 id="share-title" className="font-display text-2xl font-black">
          {heading}
        </h2>
        <p className="mt-1 text-muted">
          Currently <strong className="text-forest">{visibilityLabel(saved)}</strong>.{" "}
          {visibilityDetail(saved)}
        </p>

        <label htmlFor="share-url" className="sr-only">
          Guest link
        </label>
        <input
          id="share-url"
          ref={urlRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-4 w-full truncate rounded-lg bg-paper px-3 py-3 font-mono text-sm text-forest ring-1 ring-forest/15"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={copy}
            className="min-h-12 rounded-full bg-forest px-4 font-bold text-paper active:scale-[0.98]"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <a
            href={sharePath}
            target="_blank"
            rel="noreferrer"
            aria-label="Preview the guest view in a new tab"
            className="grid min-h-12 place-items-center rounded-full px-4 font-bold text-forest ring-2 ring-forest"
          >
            Preview
          </a>
        </div>
        <span aria-live="polite" className="sr-only">
          {copied ? "Link copied" : ""}
        </span>

        <figure className="mt-6 flex flex-col items-center gap-3">
          <div className="rounded-xl bg-surface p-3 ring-1 ring-forest/15">
            <QRCodeSVG
              value={url}
              size={200}
              fgColor={FOREST}
              bgColor={SURFACE}
              level="M"
              marginSize={2}
              title={`QR code for ${url}`}
            />
          </div>
          <figcaption className="text-center text-sm text-muted">
            Point a phone camera here to open the guest view.
          </figcaption>
        </figure>
        {isLocalHost() ? (
          <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-sm text-rust">
            This link points at <span className="font-mono">{window.location.host}</span>, which only works on this
            computer. A phone needs the deployed site.
          </p>
        ) : null}
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-2 font-display text-xl font-extrabold">Change who can open it</legend>
        <VisibilityPicker name="share-visibility" value={visibility} onChange={setVisibility} disabled={saving} />
        {visibility === "private" ? (
          <div className="grid gap-1 rounded-lg bg-surface px-4 py-3 ring-1 ring-forest/15">
            <p className="font-bold">People who can view</p>
            {viewers.length ? (
              <ul className="flex flex-wrap gap-2">
                {viewers.map((viewer) => (
                  <li key={viewer} className="rounded-full bg-paper px-3 py-1 text-sm ring-1 ring-forest/20">
                    {viewer}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Just you.</p>
            )}
            <p className="text-sm text-muted">Adding and removing people is coming soon.</p>
          </div>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="min-h-12 rounded-full bg-forest px-6 font-bold text-paper disabled:bg-forest/30 disabled:text-forest/70"
        >
          {saving ? "Saving…" : "Save sharing"}
        </button>
        {message ? (
          <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-rust" : ""}>
            {message.text}
          </p>
        ) : null}
      </fieldset>

      {footer}
    </section>
  );
}
