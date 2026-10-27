import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot } from './helpers';

test('Extract all toolbar icons to toolbar-icons folder', async ({ page }) => {
  await boot(page);

  const iconData = await page.evaluate(async () => {
    const { tools } = await import('/src/app/registry.ts');
    const { svg } = await import('/src/app/icons.ts');
    const { toolGroups } = await import('/src/app/toolbar.ts');

    const result: { id: string; label: string; group: string; icon: string; svgMarkup: string }[] = [];
    for (const t of tools.values()) {
      if (!toolGroups.includes(t.group)) continue;
      // Get SVG markup with 24x24 standard size
      const markup = svg(t.icon, 24);
      result.push({
        id: t.id,
        label: t.label,
        group: t.group,
        icon: t.icon,
        svgMarkup: markup,
      });
    }
    return result;
  });

  const outDir = resolve('toolbar-icons');
  mkdirSync(outDir, { recursive: true });

  console.log(`Found ${iconData.length} toolbar tools to extract.`);

  // Write each tool's SVG icon
  for (const item of iconData) {
    // Format SVG properly as standalone XML
    let svgContent = item.svgMarkup;
    if (!svgContent.startsWith('<?xml')) {
      // Ensure stroke="currentColor" is visible or set to "#ffffff" / customizable
      // In standalone SVG, stroke="currentColor" might be invisible if rendered without color context.
      // Standard SVG standalone practice: stroke="currentColor" or default stroke="#222222" with stroke="currentColor" fallback.
      svgContent = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${item.label} (${item.id}) -->\n${svgContent}`;
    }
    const filename = `${item.id}.svg`;
    writeFileSync(resolve(outDir, filename), svgContent, 'utf-8');
  }

  // Also write an index.json and README.md with preview/details
  writeFileSync(resolve(outDir, 'icons-manifest.json'), JSON.stringify(iconData, null, 2), 'utf-8');

  console.log(`Successfully extracted ${iconData.length} toolbar icons to ${outDir}`);
});
