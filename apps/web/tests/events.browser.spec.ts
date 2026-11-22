import { expect, test, type Page } from "@playwright/test";

// Synthetic sessions and API: these exercise the React flows, not Auth0 or the database.
const organizer = { id: "organizer-uuid", displayName: "Sam Organizer" };
const guest = { id: "guest-uuid", displayName: "Ari Guest" };
const EVENT = "11111111-1111-4111-8111-111111111111";
const CODE = "invite-code-123";

interface World { me: typeof organizer | null; maps: { id: string; shareId: string; name: string }[]; members: string[]; joined: boolean; deleted: boolean; posts: unknown[] }

async function api(page: Page, world: World) {
  const eventMaps = (role: string | null) => world.maps.map((m) => ({
    ...(role === "organizer" ? { id: m.id } : {}), shareId: m.shareId, sharePath: `/s/${m.shareId}`, name: m.name, visibility: "private", updatedAt: "2026-11-22T00:00:00Z" }));
  const role = () => world.me?.id === organizer.id ? "organizer" : world.me && world.joined ? "member" : null;
  const detail = () => ({ event: { id: EVENT, name: "Open day", description: "Labs and the main hall", ownerId: organizer.id,
    ...(role() === "organizer" ? { inviteCode: CODE } : {}) }, spaces: [], paths: [], destinations: [], role: role(), maps: eventMaps(role()) });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (path === "/api/users/me") return world.me ? route.fulfill({ json: { user: world.me } }) : route.fulfill({ status: 401, json: {} });
    if (path === "/api/events/mine") return route.fulfill({ json: { events: world.deleted || !role() ? [] : [
      { id: EVENT, name: "Open day", description: null, role: role(), mapCount: world.maps.length, memberCount: world.members.length }] } });
    if (path === "/api/events" && method === "POST") { world.posts.push(request.postDataJSON()); return route.fulfill({ status: 201, json: detail() }); }
    if (path === `/api/events/${EVENT}` && method === "GET") return role() && !world.deleted ? route.fulfill({ json: detail() }) : route.fulfill({ status: 404, json: { error: { message: "Resource not found" } } });
    if (path === `/api/events/${EVENT}` && method === "DELETE") { world.deleted = true; return route.fulfill({ status: 204 }); }
    if (path === `/api/events/${EVENT}/maps` && method === "POST") {
      const { scanId } = request.postDataJSON(); world.posts.push({ scanId });
      world.maps.push({ id: scanId, shareId: "lab-share", name: "Lab wing" }); return route.fulfill({ json: detail() });
    }
    if (path === `/api/events/${EVENT}/members`) return route.fulfill({ json: { members: world.members.map((name, i) => ({ eventId: EVENT, userId: `u${i}`, role: "member", displayName: name })) } });
    if (path === `/api/events/${EVENT}/join` && method === "GET") return url.searchParams.get("code") === CODE
      ? route.fulfill({ json: { event: { id: EVENT, name: "Open day", description: "Labs and the main hall" }, organizer: organizer.displayName, mapCount: world.maps.length, role: role() } })
      : route.fulfill({ status: 404, json: { error: { message: "Resource not found" } } });
    if (path === `/api/events/${EVENT}/join` && method === "POST") { world.posts.push(request.postDataJSON()); world.joined = true; return route.fulfill({ json: { eventId: EVENT, role: "member" } }); }
    if (path === `/api/events/${EVENT}/join` && method === "DELETE") { world.joined = false; return route.fulfill({ status: 204 }); }
    if (path === "/api/scans/mine") return route.fulfill({ json: { scans: [
      { id: "lab-scan", shareId: "lab-share", sharePath: "/s/lab-share", name: "Lab wing", format: "glb", visibility: "private", viewerIds: [], updatedAt: "2026-11-22T00:00:00Z" }] } });
    if (path.includes("/thumbnail")) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ status: 404, json: { error: { message: `unmocked ${method} ${path}` } } });
  });
}

const world = (me: World["me"], extra: Partial<World> = {}): World => ({ me, maps: [], members: [], joined: false, deleted: false, posts: [], ...extra });

test("organizer creates an event from the sidebar, adds a map and gets an invite link", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const w = world(organizer, { members: ["Ari Guest"] });
  await api(page, w);
  await page.goto("/maps");
  const sidebar = page.locator("aside");
  const toggle = sidebar.getByRole("button", { name: "Events" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const list = sidebar.getByRole("list", { name: "Events" });
  await expect(list.getByRole("link").first()).toHaveText("Create event");
  await expect(list.getByRole("link", { name: "Open day" })).toBeVisible();
  await list.getByRole("link", { name: "Create event" }).click();

  await page.getByLabel("Name").fill("  Open day ");
  await page.getByLabel(/Description/).fill("Labs and the main hall");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(`/events/${EVENT}`);
  expect(w.posts[0]).toEqual({ name: "Open day", description: "Labs and the main hall" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open day");
  await expect(page.getByText("You organize this event")).toBeVisible();
  await expect(page.getByLabel("Invite link")).toHaveValue(`http://127.0.0.1:5190/events/${EVENT}/join?code=${CODE}`);
  await expect(page.getByRole("list", { name: "Event members" })).toContainText("Ari Guest");

  await page.getByLabel("Add one of your maps").selectOption({ label: "Lab wing" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect(w.posts[1]).toEqual({ scanId: "lab-scan" });
  await expect(page.getByRole("region", { name: "Maps" }).getByRole("link", { name: /Lab wing/ })).toHaveAttribute("href", "/s/lab-share");
  await expect(page.getByRole("button", { name: "Remove Lab wing from the event" })).toBeVisible();
  await expect(page.getByText("All your maps are in this event.")).toBeVisible();

  await page.getByRole("button", { name: "Delete event" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete event" }).click();
  await expect(page).toHaveURL("/events");
  await expect(page.getByRole("main").getByText("No events yet", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("an invite link asks signed-out visitors to sign in and comes back", async ({ page }) => {
  await api(page, world(null, { maps: [{ id: "lab-scan", shareId: "lab-share", name: "Lab wing" }] }));
  await page.goto(`/events/${EVENT}/join?code=${CODE}`);
  await expect(page.getByText("Sam Organizer invited you to")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open day" })).toBeVisible();
  await expect(page.getByText("1 map with directions")).toBeVisible();
  const signIn = page.getByRole("link", { name: "Sign in to join" });
  expect(new URL(await signIn.getAttribute("href") ?? "", "http://x").searchParams.get("returnTo")).toBe(`/events/${EVENT}/join?code=${CODE}`);
});

test("a signed-in guest joins, sees only the event's maps, and can leave", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const w = world(guest, { maps: [{ id: "lab-scan", shareId: "lab-share", name: "Lab wing" }] });
  await api(page, w);
  await page.goto(`/events/${EVENT}/join?code=${CODE}`);
  await page.getByRole("button", { name: "Join event" }).click();
  await expect(page).toHaveURL(`/events/${EVENT}`);
  expect(w.posts).toEqual([{ inviteCode: CODE }]);
  await expect(page.getByText("You joined this event")).toBeVisible();
  await expect(page.getByRole("region", { name: "Maps" }).getByRole("link", { name: /Lab wing/ })).toBeVisible();
  await expect(page.getByLabel("Invite link")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Members" })).toHaveCount(0);
  await page.locator("aside").getByRole("button", { name: "Events" }).click(); // already open on event pages: closes
  await page.locator("aside").getByRole("button", { name: "Events" }).click();
  await expect(page.locator("aside").getByRole("link", { name: "Open day" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Leave event" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave event" }).click();
  await expect(page).toHaveURL("/events");
  await page.goto(`/events/${EVENT}`);
  await expect(page.getByRole("alert")).toContainText("you haven't joined it");
  expect(errors).toEqual([]);
});

test("a wrong invite code says the link doesn't work", async ({ page }) => {
  await api(page, world(guest));
  await page.goto(`/events/${EVENT}/join?code=wrong`);
  await expect(page.getByRole("alert")).toContainText("This invite link doesn't work");
  await expect(page.getByRole("button", { name: "Join event" })).toHaveCount(0);
});

test("phones reach events from the tab bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await api(page, world(guest, { joined: true }));
  await page.goto("/maps");
  const tabs = page.getByRole("navigation", { name: "Main" }).last();
  await tabs.getByRole("link", { name: "Events" }).click();
  await expect(page).toHaveURL("/events");
  await expect(page.getByRole("link", { name: /Open day/ })).toContainText("Joined");
  await expect(page.getByRole("link", { name: "Create event" })).toBeVisible();
});
