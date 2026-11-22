import { Ellipsis, Globe, Link2, Lock, UserRound } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { shareUrl } from "../lib/scans";
import { thumbnailPath } from "../lib/thumbnails";
import type { MapOrigin, MapSummary } from "../lib/maps";

/** Small deterministic random generator so each map gets a stable preview. */
function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const DOT_COLORS = ["#A9C4AE", "#A9C4AE", "#A9C4AE", "#67A5C2", "#FDB12A", "#C58BE0"];

/**
 * A stylized preview on night: a scatter of scan-like dots along a corridor and a
 * coral route. Stands in until real thumbnails are rendered from the scan.
 */
function MapThumb({ seed }: { seed: string }) {
  const { dots, route } = useMemo(() => {
    const rand = seeded(seed);
    const pts: [number, number][] = [];
    let x = 15 + rand() * 20;
    let y = 80 - rand() * 15;
    for (let i = 0; i < 5; i++) {
      pts.push([x, y]);
      x = Math.min(185, x + 25 + rand() * 20);
      y = Math.max(20, Math.min(100, y + (rand() - 0.55) * 45));
    }
    const dots = Array.from({ length: 90 }, () => {
      const [ax, ay] = pts[Math.floor(rand() * (pts.length - 1))]!;
      return {
        cx: ax + rand() * 40 - 6,
        cy: ay + (rand() - 0.5) * 34,
        r: 1.2 + rand() * 1.6,
        fill: DOT_COLORS[Math.floor(rand() * DOT_COLORS.length)]!,
        o: 0.45 + rand() * 0.5,
      };
    });
    return { dots, route: pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ") };
  }, [seed]);

  return (
    <svg viewBox="0 0 200 120" className="block aspect-[5/3] w-full bg-night" aria-hidden="true">
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={d.fill} opacity={d.o} />
      ))}
      <polyline points={route} fill="none" stroke="#F48057" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 5" />
    </svg>
  );
}

/**
 * The map's saved picture (a dollhouse view rendered when the owner first opened it).
 * Until there is one, or if it can't load, the stylized preview stands in.
 */
function MapPreview({ shareId }: { shareId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MapThumb seed={shareId} />;
  return (
    <img
      src={thumbnailPath(shareId)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="block aspect-[5/3] w-full bg-night object-cover"
    />
  );
}

const VISIBILITY_BADGE = {
  public: { label: "Public", Icon: Globe },
  unlisted: { label: "Unlisted", Icon: Link2 },
  private: { label: "Private", Icon: Lock },
} as const;

function formatDate(iso?: string) {
  if (!iso) return null;
  const date = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Account names are often email addresses: show the part before the @ (the card's title has the rest). */
function personName(name: string) {
  const at = name.indexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}

export async function copyMapLink(map: MapSummary) {
  try {
    await navigator.clipboard.writeText(shareUrl(map.sharePath));
    toast.success("Link copied", { description: map.name });
  } catch {
    toast.error("Couldn't copy the link", { description: shareUrl(map.sharePath) });
  }
}

/**
 * The "⋯" menu on a card: a disclosure button and a short list of actions. Escape or
 * a click outside closes it and returns focus to the button.
 */
function CardMenu({ map, onDelete }: { map: MapSummary; onDelete?: (map: MapSummary) => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel) {
      // Keep the menu on screen: on a phone, a card in the left column is narrower than the menu.
      const rect = panel.getBoundingClientRect();
      const margin = 8;
      const shift =
        rect.left < margin ? margin - rect.left : rect.right > window.innerWidth - margin ? window.innerWidth - margin - rect.right : 0;
      panel.style.transform = shift ? `translateX(${Math.round(shift)}px)` : "";
      panel.querySelector<HTMLElement>("a, button")?.focus();
    }
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && panelRef.current?.parentElement?.contains(event.target as Node)) return;
      setOpen(false);
      if (event instanceof KeyboardEvent) buttonRef.current?.focus();
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, [open]);

  const item = "flex min-h-11 w-full items-center rounded-lg px-3 text-left font-bold hover:bg-forest/8";

  return (
    <div className="absolute top-2 right-2 z-10">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`More for ${map.name}`}
        onClick={() => setOpen((value) => !value)}
        className="grid size-11 place-items-center rounded-full bg-paper/95 text-forest shadow ring-1 ring-forest/15"
      >
        <Ellipsis className="size-5" aria-hidden />
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          data-surface="light"
          className="absolute top-12 right-0 z-20 grid w-48 gap-0.5 rounded-xl bg-surface p-1.5 text-forest shadow-xl ring-1 ring-forest/15"
        >
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void copyMapLink(map);
            }}
          >
            Copy link
          </button>
          {map.owned ? (
            <>
              <Link to={`/maps/${map.id}`} className={item}>
                Manage map
              </Link>
              <button
                type="button"
                className={`${item} text-rust`}
                onClick={() => {
                  setOpen(false);
                  onDelete?.(map);
                }}
              >
                Delete…
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function MapCard({
  map,
  origin,
  onDelete,
  showMenu = false,
}: {
  map: MapSummary;
  /** The page this card is on, so the map can offer a way back to it. */
  origin?: { path: string; label: string };
  onDelete?: (map: MapSummary) => void;
  showMenu?: boolean;
}) {
  const badge = VISIBILITY_BADGE[map.visibility];
  const updated = formatDate(map.updated);

  // The link and the menu button are siblings, so there's no button inside a link.
  return (
    <article className="relative h-full rounded-2xl bg-surface shadow-sm ring-1 ring-forest/10 transition-transform has-[a.card-link:hover]:-translate-y-0.5">
      <Link
        to={map.sharePath}
        state={origin ? ({ from: origin.path, fromLabel: origin.label, mapName: map.name } satisfies MapOrigin) : undefined}
        className="card-link block h-full rounded-2xl focus-visible:outline-offset-[-3px]"
      >
        {/* Only the preview is clipped to the rounded corners, so the ⋯ menu can extend past the card. */}
        <div className="overflow-hidden rounded-t-2xl">
          <MapPreview shareId={map.id} />
        </div>
        <div className="grid gap-1 p-3">
          <h2 className="leading-snug font-bold">{map.name}</h2>
          {/* One short line (sharing, kind of place, date), then who shared it on its own line,
              so nothing wraps into a stray "·" at the start of a line. */}
          <p className="flex items-center gap-1.5 text-sm whitespace-nowrap text-muted">
            <badge.Icon className="size-3.5 shrink-0" aria-hidden />
            {badge.label}
            {map.place ? <><span aria-hidden>·</span>{map.place}</> : null}
            {updated ? <><span aria-hidden>·</span>{updated}</> : null}
          </p>
          {map.sharedBy ? (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted" title={`Shared by ${map.sharedBy}`}>
              <UserRound className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                Shared by <span className="font-bold text-forest">{personName(map.sharedBy)}</span>
              </span>
            </p>
          ) : null}
        </div>
      </Link>
      {showMenu ? <CardMenu map={map} onDelete={onDelete} /> : null}
    </article>
  );
}

/** Grey placeholder shaped like a card, shown while maps load. */
export function MapCardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-2xl bg-surface ring-1 ring-forest/10">
      <div className="aspect-[5/3] bg-forest/10 motion-safe:animate-pulse" />
      <div className="grid gap-2 p-3">
        <div className="h-4 w-3/4 rounded bg-forest/10" />
        <div className="h-3 w-1/2 rounded bg-forest/10" />
      </div>
    </div>
  );
}
