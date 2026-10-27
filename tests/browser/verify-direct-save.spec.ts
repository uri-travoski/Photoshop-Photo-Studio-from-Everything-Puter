import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, tool, canvasClick, idle, menu } from './helpers';

test('Open image via File System Access API handle, add text, click File > Save, verify original file on disk is directly updated', async ({ page }) => {
  // 1. Create a pristine test image file on disk
  const imgPath = resolve('test-direct-handle.png');
  const initialBytes = readFileSync('sample-original.png');
  writeFileSync(imgPath, initialBytes);
  console.log(`Initial file created at ${imgPath}, initial size: ${initialBytes.length} bytes`);

  // 2. Open Photo Studio
  await boot(page);

  // 3. Mock showOpenFilePicker to return a FileSystemFileHandle that writes directly to imgPath on disk
  await page.exposeFunction('nodeWriteFile', async (base64Data: string) => {
    const buf = Buffer.from(base64Data, 'base64');
    writeFileSync(imgPath, buf);
    console.log(`[Node] Directly wrote ${buf.length} bytes to ${imgPath}`);
  });

  await page.evaluate(async (initialBytesArray) => {
    const initialBuf = new Uint8Array(initialBytesArray);
    const mockFile = new File([initialBuf], 'test-direct-handle.png', { type: 'image/png' });

    // Mock FileSystemFileHandle
    const mockHandle = {
      kind: 'file',
      name: 'test-direct-handle.png',
      getFile: async () => mockFile,
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (data: Blob | ArrayBuffer | Uint8Array) => {
            if (data instanceof Blob) {
              const buf = new Uint8Array(await data.arrayBuffer());
              chunks.push(buf);
            } else if (data instanceof ArrayBuffer) {
              chunks.push(new Uint8Array(data));
            } else {
              chunks.push(data);
            }
          },
          close: async () => {
            let totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.length;
            }
            // Send to nodeWriteFile via base64
            let binary = '';
            for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
            const b64 = btoa(binary);
            await (window as any).nodeWriteFile(b64);
          },
        };
      },
    };

    window.showOpenFilePicker = async () => [mockHandle];
  }, Array.from(initialBytes));

  // 4. Click File > Open from the menu
  await menu(page, 'File', 'Open…');
  await page.waitForFunction(
    () => window.photoStudio.hasDocument && window.photoStudio.session.fileName === 'test-direct-handle.png'
  );
  await idle(page);
  console.log('Image opened via showOpenFilePicker with handle.');

  // Verify session has fileHandle
  const hasHandle = await page.evaluate(() => !!window.photoStudio.session.fileHandle);
  expect(hasHandle).toBe(true);

  // 5. Add text using Horizontal Type Tool
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 50, 50);
  const textInput = page.getByRole('textbox', { name: 'Text input' });
  await expect(textInput).toBeFocused();
  await page.keyboard.type('Direct File Save Test');
  await page.keyboard.press('Escape');
  await idle(page);

  // Verify dirty indicator is visible
  await expect(page.locator('#dirty')).toBeVisible();

  // 6. Click File > Save from the menu
  console.log('Clicking File > Save...');
  await menu(page, 'File', 'Save');
  await idle(page);

  // 7. Verify dirty indicator is gone
  await expect(page.locator('#dirty')).toBeHidden();

  // 8. Now check the ORIGINAL image file on disk!
  const updatedDiskBytes = readFileSync(imgPath);
  console.log(`Original file on disk after save: ${updatedDiskBytes.length} bytes (was ${initialBytes.length} bytes)`);
  expect(updatedDiskBytes.length).toBeGreaterThan(0);
  expect(updatedDiskBytes.length).not.toEqual(initialBytes.length);

  // 9. Inspect the updated file on disk: decode PNG and verify the text pixels exist
  await page.evaluate(async (bytesArray) => {
    const uint8 = new Uint8Array(bytesArray);
    const blob = new Blob([uint8], { type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'check-disk.png');
  }, Array.from(updatedDiskBytes));
  await idle(page);

  const textPixelCount = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const comp = await compositeRGBA(window.photoStudio);
    let darkPixelCount = 0;
    for (let i = 0; i < comp.data.length; i += 4) {
      const r = comp.data[i], g = comp.data[i+1], b = comp.data[i+2];
      // Text pixels are black #000000 against blue background #326496
      if (r < 25 && g < 25 && b < 25) {
        darkPixelCount++;
      }
    }
    return darkPixelCount;
  });

  console.log(`Verified text pixels rendered into original disk file: ${textPixelCount}`);
  expect(textPixelCount).toBeGreaterThan(10);
});
