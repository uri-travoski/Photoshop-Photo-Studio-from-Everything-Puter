import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, tool, canvasClick, idle, menu, downloadFrom } from './helpers';

test('Open image, add text, save, and check saved image', async ({ page }) => {
  // 1. Create a pristine test image file on disk
  const imgPath = resolve('test-open-save.png');
  const initialBytes = readFileSync('sample-original.png');
  writeFileSync(imgPath, initialBytes);
  console.log(`Original file created at ${imgPath}, size: ${initialBytes.length} bytes`);

  // 2. Open Photo Studio
  await boot(page);

  // 3. Open the image in Photo Studio
  const input = page.locator('#file-input');
  await input.setInputFiles(imgPath);
  await page.waitForFunction(
    () => window.photoStudio.hasDocument && window.photoStudio.session.fileName === 'test-open-save.png'
  );
  await idle(page);
  console.log('Image opened in Photo Studio successfully.');

  // 4. Add text using Horizontal Type Tool
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 50, 50);
  const textInput = page.getByRole('textbox', { name: 'Text input' });
  await expect(textInput).toBeFocused();
  await page.keyboard.type('Hello World');
  await page.keyboard.press('Escape');
  await idle(page);

  // Verify text layer was created
  const layerInfo = await page.evaluate(() => {
    const l = window.photoStudio.layer;
    return { name: l?.name, kind: l?.kind };
  });
  console.log('Created layer:', layerInfo);
  expect(layerInfo.kind).toBe('text');

  // Verify document is dirty
  await expect(page.locator('#dirty')).toBeVisible();

  // 5. Save the image via File > Save
  console.log('Clicking File > Save...');
  // Since #file-input was used (browser sandbox cannot grant silent raw disk write handle),
  // let's see whether downloadFrom or direct file handle was triggered:
  const isHandle = await page.evaluate(() => !!window.photoStudio.session.fileHandle);
  console.log('Does session have fileHandle?', isHandle);

  let savedBytes: Buffer;
  if (isHandle) {
    await menu(page, 'File', 'Save');
    await idle(page);
    savedBytes = readFileSync(imgPath);
  } else {
    // Standard browser download fallback when opened via file input
    const download = await downloadFrom(page, () => menu(page, 'File', 'Save'));
    console.log(`Saved via download: ${download.name}, size: ${download.bytes.length}`);
    savedBytes = download.bytes;
    // Overwrite the original image file with the saved download to check it
    writeFileSync(imgPath, savedBytes);
  }

  // Verify dirty indicator is gone
  await expect(page.locator('#dirty')).toBeHidden();

  // 6. Inspect the saved image on disk to verify the text was saved in it
  const finalBytes = readFileSync(imgPath);
  console.log(`Final file on disk size: ${finalBytes.length} bytes (was ${initialBytes.length} bytes)`);
  expect(finalBytes.length).toBeGreaterThan(0);
  expect(finalBytes.length).not.toEqual(initialBytes.length);

  // Re-open the saved image in a fresh page to verify the text is actually rendered into the pixels
  await page.evaluate(async (bytesArray) => {
    const uint8 = new Uint8Array(bytesArray);
    const blob = new Blob([uint8], { type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'reopened.png');
  }, Array.from(finalBytes));
  await idle(page);

  // Check composite pixels: the background was #326496 (RGB: 50, 100, 150).
  // The text was rendered in foreground color (black #000000 by default),
  // so there must be dark pixels rendered on the canvas!
  const hasDarkTextPixels = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const comp = await compositeRGBA(window.photoStudio);
    let darkPixelCount = 0;
    for (let i = 0; i < comp.data.length; i += 4) {
      const r = comp.data[i], g = comp.data[i+1], b = comp.data[i+2];
      // Text pixels will be significantly darker than background RGB(50, 100, 150)
      if (r < 25 && g < 25 && b < 25) {
        darkPixelCount++;
      }
    }
    return darkPixelCount;
  });

  console.log(`Detected text pixels in saved image: ${hasDarkTextPixels}`);
  expect(hasDarkTextPixels).toBeGreaterThan(10);
});
