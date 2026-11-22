import { listMyEvents } from '../../../../lib/api/event-maps';
import { api, signedIn } from '../../../../lib/api/http';

/** Events the signed-in account organizes or joined, newest first. */
export function GET(request: Request) {
  return api(request, async ({ db, user }) => Response.json(await listMyEvents(db, signedIn(user))));
}
