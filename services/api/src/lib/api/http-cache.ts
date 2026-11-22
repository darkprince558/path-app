import { createHash } from 'node:crypto';

/*
 * Browser caching for large, private map files (scene GLB, point cloud, card picture).
 *
 * Responses say `Cache-Control: private, no-cache` with a strong ETag: the browser may keep
 * the bytes but must ask before reusing them. Every request still runs the normal access
 * check first; only then does a matching `If-None-Match` get a body-less 304, which skips
 * reading (and re-hashing) the file. A map made private, or a viewer removed, gets 404 on the
 * next open, so a cached copy is never shown to someone who lost access.
 *
 * ETags must change whenever the bytes do. Scene GLBs and revision outputs are written once
 * under a fresh object key, so their key (plus size or checksum) identifies the bytes; card
 * pictures are overwritten in place, so theirs is a hash of the content.
 */

export const CACHED_ASSET_CONTROL = 'private, no-cache';

/** An opaque strong ETag. Inputs are hashed, so object keys never reach the browser. */
export function etagFor(...parts: (string | number | null | undefined)[]): string {
  const digest = createHash('sha256').update(parts.map(part => String(part ?? '')).join('\u0000')).digest('hex');
  return `"${digest.slice(0, 40)}"`;
}

/** True when the request already holds this exact version (RFC 9110 If-None-Match, weak compare). */
export function notModified(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = bare(etag);
  return header.split(',').some(tag => tag.trim() === '*' || bare(tag) === target);
}

const assetHeaders = (etag: string) => ({
  'ETag': etag, 'Cache-Control': CACHED_ASSET_CONTROL, 'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie, Authorization',
});

/**
 * Call only after access checks pass. Returns 304 when the browser's copy is current,
 * otherwise loads the bytes and returns them with caching headers.
 */
export async function cachedAsset(request: Request, etag: string, contentType: string, load: () => Promise<Uint8Array>) {
  if (notModified(request, etag)) return new Response(null, { status: 304, headers: assetHeaders(etag) });
  const bytes = await load();
  return new Response(Uint8Array.from(bytes), { headers: {
    ...assetHeaders(etag), 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength),
  } });
}

/** For content overwritten in place (card pictures): the ETag is the content itself. */
export function contentEtag(bytes: Uint8Array): string {
  return etagFor('content', createHash('sha256').update(bytes).digest('hex'));
}
