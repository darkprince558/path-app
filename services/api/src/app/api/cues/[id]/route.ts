import { api, body, signedIn } from '../../../../lib/api/http';
import { cuePatch, updateCue } from '../../../../lib/api/cues';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({
    cue: await updateCue(db, signedIn(user), id, await body(request, cuePatch)),
  }));
}
