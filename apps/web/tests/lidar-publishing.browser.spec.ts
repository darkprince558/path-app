import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, launchOptions: {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} });
test.setTimeout(90000);

test('approved LiDAR shares and space navigation render while private scenes/frames stay protected', async ({ page, request }, info) => {
  const shareUrl = process.env.TEST_LIDAR_SHARE_URL;
  const spaceUrl = process.env.TEST_LIDAR_SPACE_URL;
  const privateUrl = process.env.TEST_LIDAR_PRIVATE_SHARE_URL;
  const manualUrl = process.env.TEST_LIDAR_MANUAL_SHARE_URL;
  const scanId = process.env.TEST_LIDAR_SCAN_ID;
  if (!shareUrl || !spaceUrl || !privateUrl || !manualUrl || !scanId) throw new Error('Set the TEST_LIDAR_* URLs/scan ID from the publishing fixture report');
  const errors: string[] = [], downloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const expectedGuest = message.location().url.includes('/api/users/me') && message.text().includes('401');
    if (message.type() === 'error' && !expectedGuest) errors.push(message.text());
  });
  page.on('response', response => { if (response.ok() && /\/scene$|\/file$/.test(new URL(response.url()).pathname)) downloads.push(response.url()); });
  await page.goto(shareUrl);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('A 3D model of the shared scan.', { exact: false })).toHaveCount(1);
  await expect.poll(() => downloads.some(url => url.endsWith('/scene'))).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('approved-share.png'), fullPage: true });
  const shareId = new URL(shareUrl).pathname.split('/').at(-1)!;
  const origin = new URL(shareUrl).origin;
  const metadata = await (await request.get(`${origin}/api/shares/${shareId}`)).json();
  expect(metadata.transform).toEqual([2,0,0,0, 0,2,0,0, 0,0,2,0, 3,0,-2,1]);
  expect(metadata.revisionId).toBeTruthy();
  expect((await request.get(`${origin}/api/shares/${shareId}/points`)).status()).toBe(200);
  expect((await request.get(`${origin}/api/shares/${shareId}/frames/junction-02`)).status()).toBe(404);
  await page.goto(spaceUrl);
  await expect(page.getByRole('heading', { name: 'Find a route' })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Downloading and building the 3D view…')).toHaveCount(0);
  await expect(page.getByText(/1 connected segments/)).toBeVisible();
  expect(downloads.some(url => url.endsWith(`/api/scans/${scanId}/file`))).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('approved-space-saved-route.png'), fullPage: true });
  await page.goto(manualUrl);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  const privateShareId = new URL(privateUrl).pathname.split('/').at(-1)!;
  for (const suffix of ['', '/scene', '/points', '/frames/junction-02']) {
    expect((await request.get(`${origin}/api/shares/${privateShareId}${suffix}`)).status()).toBe(404);
  }
  await page.goto(privateUrl);
  await expect(page.getByRole('alert')).toContainText("This link isn't open to you");
  await expect(page.locator('canvas')).toHaveCount(0);
});
