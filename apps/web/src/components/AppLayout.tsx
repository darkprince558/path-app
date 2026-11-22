import { CalendarDays, Map as MapIcon, Plus, Settings as SettingsIcon, Users } from "lucide-react";
import { Fragment, useEffect, useState, type ComponentType } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { Toaster } from "sonner";
import { AccountControls } from "../lib/auth";
import { MyEventsProvider } from "../lib/events";
import EventsNav from "./EventsNav";
import { Wordmark } from "./Logo";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

const NAV: NavItem[] = [
  { to: "/maps", label: "My maps", icon: MapIcon },
  { to: "/community", label: "Community", icon: Users },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

/** Phone tab for the Events list; the sidebar has the Events dropdown instead. */
const EVENTS_TAB: NavItem = { to: "/events", label: "Events", icon: CalendarDays };

/**
 * Signed-in shell. Desktop: forest sidebar (My maps, Community, Events dropdown, Settings,
 * New map, account). Phone: slim top bar plus a bottom tab bar, since a sidebar doesn't fit at 375px.
 */
export default function AppLayout() {

  return (
    <MyEventsProvider>
    <div className="min-h-dvh bg-paper md:flex">
      <SkipLink />
      {/* Desktop sidebar */}
      <aside data-surface="forest" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-forest px-4 py-6 text-paper md:flex">
        <Link to="/" className="px-3 text-3xl">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="mt-8 grid gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Fragment key={to}>
            <NavLink
              to={to}
              end
              className={({ isActive }) =>
                `flex min-h-11 items-center gap-3 rounded-lg px-3 font-bold transition-colors ${
                  isActive ? "bg-paper/12 text-paper" : "text-sage hover:bg-paper/6 hover:text-paper"
                }`
              }
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </NavLink>
            {to === "/community" ? <EventsNav /> : null}
            </Fragment>
          ))}
        </nav>
        <Link
          to="/maps/new"
          className="mt-6 flex min-h-11 items-center justify-center gap-2 rounded-full bg-coral px-4 font-bold text-ink"
        >
          <Plus className="size-5" aria-hidden />
          New map
        </Link>
        <div className="mt-auto px-1">
          {/* Name on the left, Sign out on the right edge of the sidebar. */}
          <AccountControls className="w-full flex-nowrap justify-between" />
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-paper/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur md:hidden">
        <Link to="/" className="text-2xl">
          <Wordmark />
        </Link>
        <div className="-mr-1 flex items-center gap-1">
          <Link to="/settings" aria-label="Settings" className="grid size-11 place-items-center rounded-full text-muted">
            <SettingsIcon className="size-5" aria-hidden />
          </Link>
          <AccountControls />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-4 pb-28 focus:outline-none md:px-10 md:pt-10 md:pb-12">
        <Outlet />
      </main>

      <AppToaster />

      {/* Phone tab bar */}
      <nav
        aria-label="Main"
        data-surface="forest"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 bg-forest px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-paper md:hidden"
      >
        <TabLink item={NAV[0]!} />
        <TabLink item={EVENTS_TAB} end={false} />
        <Link
          to="/maps/new"
          className="mx-auto -mt-6 grid size-14 place-items-center rounded-full bg-coral text-ink shadow-lg ring-4 ring-paper"
          aria-label="New map"
        >
          <Plus className="size-7" aria-hidden />
        </Link>
        <TabLink item={NAV[1]!} />
        <TabLink item={NAV[2]!} />
      </nav>
    </div>
    </MyEventsProvider>
  );
}

function TabLink({ item: { to, label, icon: Icon }, end = true }: { item: NavItem; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-12 flex-col items-center justify-center gap-0.5 text-xs font-bold ${
          isActive ? "text-paper" : "text-sage"
        }`
      }
    >
      <Icon className="size-6" aria-hidden />
      {label}
    </NavLink>
  );
}

/** First thing a keyboard user reaches: jumps past the menu to the page content. */
export function SkipLink() {
  return (
    <a
      href="#main"
      data-surface="forest"
      className="fixed top-2 left-2 z-50 -translate-y-24 rounded-full bg-forest px-5 py-3 font-bold text-paper shadow-lg focus:translate-y-0"
    >
      Skip to main content
    </a>
  );
}

/** True while the sidebar layout is showing (Tailwind's md breakpoint, 48rem). */
function useWideLayout(): boolean {
  const query = "(min-width: 48rem)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setWide(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * Pop-up messages ("Link copied", "Map deleted"). With the sidebar they sit at the
 * bottom left of the content, just right of the sidebar (w-60 = 15rem). Without it
 * they're centered above the phone tab bar. Offsets use rem, so they follow the
 * text size setting like the sidebar does.
 */
function AppToaster() {
  const wide = useWideLayout();
  const offset = wide
    ? { left: "calc(15rem + 1.5rem)", bottom: "1.5rem" }
    : { bottom: "calc(5.75rem + env(safe-area-inset-bottom))" };
  return (
    <Toaster
      position={wide ? "bottom-left" : "bottom-center"}
      offset={offset}
      mobileOffset={offset}
      // Forest toasts with paper text (8.1:1). Sonner announces them in a polite live region.
      toastOptions={{ className: "!bg-forest !text-paper !border-0 !font-sans", descriptionClassName: "!text-sage" }}
    />
  );
}
