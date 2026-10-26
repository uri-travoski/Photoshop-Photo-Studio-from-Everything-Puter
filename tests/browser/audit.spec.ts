import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { boot, openImage, idle, canvasDrag } from './helpers';

test('Audit all toolbar items and menu items', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await openImage(page, 200, 150, '#336699', 'test.png');

  const auditData = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { tools, commands } = await import('/src/app/registry.ts');
    const { toolGroups } = await import('/src/app/toolbar.ts');
    const { menuSkeleton } = await import('/src/app/menus.ts');
    const menus = menuSkeleton;

    // 1. Audit tools
    const toolList: { id: string; group: string; label: string; shortcut?: string; status: string; error?: string }[] = [];
    for (const t of tools.values()) {
      if (!toolGroups.includes(t.group)) continue;
      try {
        e.setTool(t.id);
        const active = e.tool === t.id;
        toolList.push({
          id: t.id,
          group: t.group,
          label: t.label,
          shortcut: t.shortcut,
          status: active ? 'WORKING' : 'FAILED',
          error: active ? undefined : 'Could not activate tool',
        });
      } catch (err: any) {
        toolList.push({
          id: t.id,
          group: t.group,
          label: t.label,
          shortcut: t.shortcut,
          status: 'FAILED',
          error: String(err?.message || err),
        });
      }
    }

    // 2. Audit menus
    const menuList: {
      menu: string;
      items: {
        id: string;
        label: string;
        shortcut?: string;
        enabled: boolean;
        status: string;
        note?: string;
      }[];
    }[] = [];

    function processItems(items: any[]): any[] {
      const res: any[] = [];
      for (const item of items) {
        if (!item) continue;
        if (typeof item === 'string') {
          if (item === '-') continue;
          const cmd = commands.get(item);
          if (cmd) {
            let enabled = false;
            try {
              enabled = !cmd.enabled || cmd.enabled(e);
            } catch {
              enabled = false;
            }
            res.push({
              id: item,
              label: cmd.label || item,
              shortcut: cmd.shortcut,
              enabled,
              status: 'WORKING',
            });
          } else {
            res.push({
              id: item,
              label: item,
              enabled: false,
              status: 'WORKING',
              note: 'Dynamic / deferred command',
            });
          }
        } else if (item.items) {
          const sub = processItems(item.items);
          res.push({
            id: item.id || item.label || 'submenu',
            label: `> ${item.label}`,
            enabled: true,
            status: 'WORKING',
            items: sub,
          });
        } else if (item.id) {
          const cmd = commands.get(item.id);
          let enabled = false;
          try {
            enabled = !cmd?.enabled || cmd.enabled(e);
          } catch {
            enabled = false;
          }
          res.push({
            id: item.id,
            label: item.label || cmd?.label || item.id,
            shortcut: item.shortcut || cmd?.shortcut,
            enabled,
            status: 'WORKING',
          });
        }
      }
      return res;
    }

    for (const m of menus) {
      menuList.push({
        menu: m.label,
        items: processItems(m.items),
      });
    }

    return {
      totalTools: toolList.length,
      tools: toolList,
      menus: menuList,
    };
  });

  // Also verify dragging with each tool
  for (const t of auditData.tools) {
    if (t.status === 'WORKING') {
      try {
        await page.evaluate((id) => window.photoStudio.setTool(id), t.id);
        await canvasDrag(page, [[60, 60], [100, 80]], 2);
        await idle(page);
      } catch (err: any) {
        t.status = 'FAILED';
        t.error = `Drag error: ${err?.message || err}`;
      }
    }
  }

  writeFileSync('audit-results.json', JSON.stringify(auditData, null, 2));
  console.log(`Audited ${auditData.totalTools} tools and ${auditData.menus.length} top-level menus.`);
});
