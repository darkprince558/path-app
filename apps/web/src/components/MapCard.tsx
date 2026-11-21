import { Globe, Link2, Lock } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { MapSummary } from "../lib/maps";

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

const VISIBILITY_BADGE = {
  public: { label: "Public", Icon: Globe },
  unlisted: { label: "Unlisted", Icon: Link2 },
  private: { label: "Private", Icon: Lock },
} as const;

function formatDate(iso?: string) {
  if (!iso) return null;
  const date = new Date(`${iso}T12:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MapCard({ map, sample = false }: { map: MapSummary; sample?: boolean }) {
  const badge = VISIBILITY_BADGE[map.visibility];
  const updated = formatDate(map.updated);

  const body = (
    <>
      <MapThumb seed={map.id} />
      <div className="grid gap-1.5 p-3">
        <h3 className="leading-snug font-bold">{map.name}</h3>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span className="inline-flex items-center gap-1">
            <badge.Icon className="size-3.5" aria-hidden />
            {badge.label}
          </span>
          {map.sharedBy ? <span>· Shared by {map.sharedBy}</span> : null}
          {map.place ? <span>· {map.place}</span> : null}
          {updated ? <span className="font-mono text-xs">· {updated}</span> : null}
        </p>
      </div>
    </>
  );

  const frame = "overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-forest/10";

  if (sample || !map.sharePath) {
    return (
      <article className={`${frame} relative`} aria-label={`${map.name} (sample)`}>
        <span className="absolute top-2 left-2 rounded-full bg-paper/90 px-2 py-0.5 font-mono text-[11px] text-forest">
          sample
        </span>
        {body}
      </article>
    );
  }

  return (
    <Link
      to={map.sharePath}
      className={`${frame} block transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5 active:scale-[0.99]`}
    >
      <article>{body}</article>
    </Link>
  );
}
