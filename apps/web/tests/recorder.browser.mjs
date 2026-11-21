// Independent acceptance against a running Mac recorder and its real reconstruction worker.
// Run from the repo: RECORDER_ORIGIN=https://... RECORDER_KEY_FILE=/path/to/organizer.key \
//   RECORDER_PYTHON=/path/to/capture-venv/bin/python node apps/web/tests/recorder.browser.mjs
// Install the web workspace dependencies first. Requires ffmpeg, a Chromium installation
// (set RECORDER_CHROME_CHANNEL=chrome to use system Chrome), and the capture Python packages.
// Optional RECORDER_EVIDENCE_DIR retains a guest screenshot and a report; raw media stays
// in the Mac service's private job folder. Physical camera and motion quality require an iPhone run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(process.env.RECORDER_ORIGIN, 'Set RECORDER_ORIGIN to the running Mac recorder URL.');
const origin = new URL(process.env.RECORDER_ORIGIN).origin;
const keyFile = process.env.RECORDER_KEY_FILE;
assert(keyFile, 'Set RECORDER_KEY_FILE to the private key file printed by the recorder launcher.');
const key = (await readFile(keyFile, 'utf8')).trim();
assert(key.length > 0, 'Empty recorder key file.');
const capturePython = process.env.RECORDER_PYTHON || path.join(repo, 'captures-local/video3d-tools/.venv/bin/python');
const viewport = { width: 390, height: 844 };
const contextOptions = {
  viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
  ignoreHTTPSErrors: process.env.RECORDER_TEST_IGNORE_HTTPS_ERRORS === '1',
};
const temp = await mkdtemp(path.join(tmpdir(), 'path-browser-hallway-'));
let browser;
try {
  const fixture = path.join(temp, 'synthetic.mp4');
  const camera = path.join(temp, 'synthetic.y4m');
  execFileSync(capturePython, [path.join(repo, 'apps/capture/video3d/testdata/make_hallway.py'), fixture], { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-i', fixture, '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', camera]);
  browser = await chromium.launch({
    ...(process.env.RECORDER_CHROME_CHANNEL ? { channel: process.env.RECORDER_CHROME_CHANNEL } : {}),
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-video-capture=' + camera,
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ],
  });

  async function startTake(permission) {
    const context = await browser.newContext(contextOptions);
    await context.addInitScript(({ permission }) => {
      Object.defineProperty(DeviceMotionEvent, 'requestPermission', { value: async () => permission });
      if (permission === 'denied') return;
      setInterval(() => {
        // Deterministic non-zero injected values exercise the browser transport, not sensor accuracy.
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
          interval: 25,
          acceleration: { x: 0.15, y: -0.04, z: 0.21 },
          accelerationIncludingGravity: { x: 0.15, y: -9.85, z: 0.21 },
          rotationRate: { alpha: 52, beta: 3, gamma: -2 },
        }));
      }, 25);
    }, { permission });
    const page = await context.newPage();
    try {
      await page.goto(origin + '/record#key=' + encodeURIComponent(key));
    } catch {
      throw new Error('The recorder page could not be opened. Verify the origin and HTTPS certificate.');
    }
    await expect.poll(() => new URL(page.url()).hash.length).toBe(0);
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();
    const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
    await expect(stop).toBeEnabled();
    if (permission === 'granted') await context.setOffline(true);
    // Use actual streaming frames and elapsed time; a virtual browser clock cannot create video.
    await page.waitForTimeout(permission === 'granted' ? 12_000 : 2_000);
    await stop.click();
    await expect(page.getByRole('button', { name: 'Process on Mac', exact: true })).toBeEnabled();
    if (permission === 'granted') await context.setOffline(false);
    return { page, context };
  }

  const denied = await startTake('denied');
  await expect(denied.page.getByText(/video only|without motion|motion .*denied/i).first()).toBeVisible();
  await denied.context.close();

  const { page, context } = await startTake('granted');
  await page.reload();
  const processButton = page.getByRole('button', { name: 'Process on Mac', exact: true });
  await expect(processButton).toBeEnabled();
  const motionUpload = page.waitForRequest(req => req.method() === 'PUT' && /\/api\/captures\/[^/]+\/motion$/.test(new URL(req.url()).pathname));
  const videoUpload = page.waitForResponse(res => res.request().method() === 'PUT' && /\/api\/captures\/[^/]+\/video$/.test(new URL(res.url()).pathname));
  const queued = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/process'));
  await processButton.click();
  const [motionReq, videoRes, queueRes] = await Promise.all([motionUpload, videoUpload, queued]);
  assert(videoRes.ok() && queueRes.ok(), 'The Mac must accept this recording and queue its reconstruction.');
  const capturePath = new URL(motionReq.url()).pathname.replace(/\/motion$/, '');
  const motion = motionReq.postDataJSON();
  assert.equal(motion.permission, 'granted');
  assert.equal(motion.timebase, 'recording-start-ms');
  assert(motion.samples.length >= 30 && motion.durationMs >= 10_000);
  assert(motion.samples.some(({ acceleration, rotationRate }) => acceleration?.z === 0.21 && rotationRate?.alpha === 52));
  assert(motion.samples.every((s, i, a) => Number.isFinite(s.tMs) && s.tMs >= 0 && (i === 0 || s.tMs >= a[i - 1].tMs)));

  let status;
  let lastStage = '';
  const queuedAt = Date.now();
  await expect.poll(async () => {
    // A Mac service restart may briefly interrupt the connection while preserving this job.
    const res = await context.request.get(origin + capturePath, {
      headers: { Authorization: 'Bearer ' + key }, timeout: 5_000,
    }).catch(() => undefined);
    if (!res || [502, 503, 504].includes(res.status())) return false;
    assert(res.ok(), 'Organizer must be able to poll the capture job.');
    status = await res.json();
    const stage = status.stage || status.status;
    if (stage !== lastStage) { console.log('Mac worker:', stage); lastStage = stage; }
    return ['failed', 'ready'].includes(status.status);
  }, { timeout: 45 * 60_000, intervals: [1_000, 3_000, 5_000] }).toBe(true);
  const reconstructionMs = Date.now() - queuedAt;
  assert.equal(status.status, 'ready', 'Synthetic hallway reconstruction failed: ' + (status.error || 'unknown error'));
  const open = page.getByRole('link', { name: 'Open 3D scan', exact: true });
  await expect(open).toBeVisible({ timeout: 15_000 });
  const share = new URL(await open.getAttribute('href'), origin);
  assert.equal(share.origin, origin);
  assert.match(share.pathname, /^\/s\/[a-zA-Z0-9_-]+$/);
  assert.equal(share.search + share.hash, '');
  assert(!share.href.includes(key));
  await context.close();

  const guest = await browser.newContext(contextOptions);
  const second = await guest.newPage();
  const reads = [];
  const errors = [];
  second.on('pageerror', e => errors.push(e.message));
  second.on('request', req => {
    if (new URL(req.url()).pathname.startsWith('/api/')) reads.push({ url: new URL(req.url()).pathname, authorized: !!req.headers().authorization });
  });
  const download = second.waitForResponse(res => new URL(res.url()).pathname.endsWith('/asset') && res.ok());
  const started = Date.now();
  await second.goto(share.href);
  const bytes = await (await download).body();
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  assert(gltf.meshes?.length && gltf.materials?.some(m => m.pbrMetallicRoughness?.baseColorTexture) &&
    gltf.images?.some(i => Number.isInteger(i.bufferView)), 'Expected a reconstructed textured, self-contained mesh.');
  const canvas = second.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect(second.getByRole('alert')).toHaveCount(0);
  const bounds = await canvas.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  // Ignore the header, footer and the drag hint, which fades on pointer-down.
  const clip = { x: Math.floor(x - 100), y: Math.floor(y - 100), width: 200, height: 200 };
  const scene = () => second.screenshot({ clip });
  let first;
  await expect.poll(async () => {
    first = await scene();
    return second.evaluate(async png => {
      const blob = new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, 200, 200).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 16) {
        colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      }
      return colors.size;
    }, first.toString('base64'));
  }).toBeGreaterThan(20);
  await second.mouse.move(x, y);
  await second.mouse.down();
  await second.mouse.move(x + 80, y - 25, { steps: 12 });
  await second.mouse.up();
  await expect.poll(async () => Buffer.compare(first, await scene())).not.toBe(0);
  const firstInteractiveMs = Date.now() - started;
  assert.deepEqual(errors, []);
  assert(reads.length >= 2 && reads.every(r => !r.authorized && r.url.startsWith('/api/shares/')));
  const deniedAccess = await guest.request.get(origin + capturePath);
  assert([401, 403, 404].includes(deniedAccess.status()), 'Guest must not read the private capture job.');
  const report = { fixture: 'generated hallway; Chromium camera and injected motion', viewport,
    browser: browser.version(), deniedMotionVideoOnly: true, recordedOffline: true, restoredDraft: true,
    motionSamples: motion.samples.length, durationMs: motion.durationMs, reconstructionMs, guestRenderAndOrbitMs: firstInteractiveMs,
    ignoredCertificateErrors: contextOptions.ignoreHTTPSErrors, glbBytes: bytes.length,
    glbSha256: createHash('sha256').update(bytes).digest('hex'), sharePath: share.pathname };
  if (process.env.RECORDER_EVIDENCE_DIR) {
    await mkdir(process.env.RECORDER_EVIDENCE_DIR, { recursive: true });
    await second.screenshot({ path: path.join(process.env.RECORDER_EVIDENCE_DIR, 'synthetic-guest.png') });
    await writeFile(path.join(process.env.RECORDER_EVIDENCE_DIR, 'synthetic-check.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
  await guest.close();
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
