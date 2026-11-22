import { generateCuesInput, generateRevisionCues } from '../../../../../../lib/api/cue-generation';
import { ApiError, api, signedIn } from '../../../../../../lib/api/http';
import { GeminiServiceClient } from '../../../../../../lib/gemini/client';
import { captureStorage } from '../../../../../../lib/storage/captures';

export const runtime = 'nodejs';
export const maxDuration = 900; // Gemini takes ~10-60 s per turn; hosts that honour this need room
type Context = { params: Promise<{ revisionId: string }> };

function geminiService() {
  if (!process.env.GEMINI_SERVICE_TOKEN) {
    throw new ApiError(503, 'GEMINI_NOT_CONFIGURED', 'Landmark directions are not set up on this server');
  }
  return new GeminiServiceClient();
}

export async function POST(request: Request, context: Context) {
  const { revisionId } = await context.params;
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    const text = await request.text();
    let json: unknown = {};
    if (text.trim()) {
      try { json = JSON.parse(text); } catch { throw new ApiError(400, 'BAD_REQUEST', 'Body must be JSON'); }
    }
    const input = generateCuesInput.parse(json);
    const result = await generateRevisionCues(db, owner, revisionId, input,
      { gemini: geminiService(), storage: captureStorage() });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
