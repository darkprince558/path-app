import { eq } from 'drizzle-orm';
import { paths, pathWaypoints, spaces } from '../../../db/schema';
import { canReadPath, readSpace } from '../../../lib/api/access';
import { api, badRequest, body, signedIn } from '../../../lib/api/http';
import { pathResponse, validateWaypoints } from '../../../lib/api/paths';
import { pathInput } from '../../../lib/api/validation';

export function GET(request: Request) {
  return api(request, async ({ db, user }) => {
    const all = await db.select().from(paths).innerJoin(spaces, eq(paths.spaceId, spaces.id));
    const visible = [];
    for (const row of all) if (await canReadPath(db, user, row.paths, row.spaces)) visible.push(row.paths);
    return Response.json({ paths: visible });
  }, true);
}
export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    const { nodeIds, ...input } = await body(request, pathInput);
    const space = await readSpace(db, owner, input.spaceId);
    if (input.visibility === 'public' && space.visibility !== 'public') throw badRequest('A public path requires a public space');
    await validateWaypoints(db, space.id, nodeIds);
    const path = await db.transaction(async (tx) => {
      const [created] = await tx.insert(paths).values({ ...input, ownerId: owner.id }).returning();
      await tx.insert(pathWaypoints).values(nodeIds.map((nodeId, sequence) => ({ pathId: created.id, spaceId: space.id, nodeId, sequence })));
      return created;
    });
    return Response.json({ path: await pathResponse(db, path) }, { status: 201 });
  });
}
