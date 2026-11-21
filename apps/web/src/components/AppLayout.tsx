import { Map as MapIcon, Plus, Settings as SettingsIcon, Users } from "lucide-react";
import type { ComponentType } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { currentUser } from "../lib/session";

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

function Avatar({ initials, className = "" }: { initials: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-9 shrink-0 place-items-center rounded-full bg-sage font-bold text-ink ${className}`}
    >
      {initials}
    </span>
  );
}

/**
 * Signed-in shell. Desktop: forest sidebar (My maps, Community, New map, account).
 * Phone: slim top bar plus a bottom tab bar, since a sidebar doesn't fit at 375px.
 */
export default function AppLayout() {
  const user = currentUser();

  return (
    <div className="min-h-dvh bg-paper md:flex">
      <SkipLink />
      {/* Desktop sidebar */}
      <aside data-surface="forest" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-forest px-4 py-6 text-paper md:flex">
        <Link to="/" className="px-3 font-display text-3xl font-black tracking-wide">
          Path
        </Link>
        <nav aria-label="Main" className="mt-8 grid gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
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
          ))}
        </nav>
        <Link
          to="/maps/new"
          className="mt-6 flex min-h-11 items-center justify-center gap-2 rounded-full bg-coral px-4 font-bold text-ink"
        >
          <Plus className="size-5" aria-hidden />
          New map
        </Link>
        <div className="mt-auto flex items-center gap-3 px-1">
          <Avatar initials={user.initials} />
          <span className="truncate font-bold">{user.name}</span>
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-paper/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur md:hidden">
        <Link to="/" className="font-display text-2xl font-black tracking-wide">
          Path
        </Link>
        <div className="-mr-1 flex items-center gap-1">
          <Link to="/settings" aria-label="Settings" className="grid size-11 place-items-center rounded-full text-muted">
            <SettingsIcon className="size-5" aria-hidden />
          </Link>
          <span className="sr-only">Signed in as {user.name}</span>
          <Avatar initials={user.initials} className="size-8 text-sm" />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-4 pb-28 focus:outline-none md:px-10 md:pt-10 md:pb-12">
        <Outlet />
      </main>

      {/* Phone tab bar */}
      <nav
        aria-label="Main"
        data-surface="forest"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-3 bg-forest px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-paper md:hidden"
      >
        <TabLink item={NAV[0]!} />
        <Link
          to="/maps/new"
          className="mx-auto -mt-6 grid size-14 place-items-center rounded-full bg-coral text-ink shadow-lg ring-4 ring-paper"
          aria-label="New map"
        >
          <Plus className="size-7" aria-hidden />
        </Link>
        <TabLink item={NAV[1]!} />
      </nav>
    </div>
  );
}

function TabLink({ item: { to, label, icon: Icon } }: { item: NavItem }) {
  return (
    <NavLink
      to={to}
      end
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
