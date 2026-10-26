// Saving native projects to Puter, opening from Puter, and Open Recent.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { serialize } from '../../model/serialization';
import { download } from '../../persistence/puter';
import { cloudRead, cloudSaveAs, cloudWrite, pickCloudFiles } from './cloud';
import { openFile } from './open';
import { noteRecent, setRecentOpener, storedBlob, type RecentSource } from './recent';
import { emitAppEvent } from '../../app/app-events';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const projectName = (name: string) => (/\.photo$/i.test(name) ? name : `${name}.photo`);

function markSaved(e: Editor, s: DocumentSession, doc: DocumentSession['saved'], item: { name: string; path: string }, blob: Blob) {
  s.storage.path = item.path;
  s.fileName = item.name;
  // Edits made while the picker was open stay dirty relative to what was written.
  s.saved = doc;
  noteRecent(e, item.name, { kind: 'puter', path: item.path });
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  void emitAppEvent('after-save', s);
}

function markLocalSaved(e: Editor, s: DocumentSession, doc: DocumentSession['saved'], name: string, blob: Blob) {
  s.fileName = name;
  s.saved = doc;
  noteRecent(e, name, { kind: 'local', blob, handle: s.fileHandle });
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  void emitAppEvent('after-save', s);
}

async function prepareSavePayload(e: Editor, s: DocumentSession, doc: PhotoDocument): Promise<{ blob: Blob; name: string; isRaster: boolean }> {
  const ext = (s.fileName?.split('.').pop() || '').toLowerCase();
  const rasterFormats = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'];
  if (rasterFormats.includes(ext)) {
    try {
      const { encodeDocument, loadSettings } = await import('./pipeline');
      const format = ext === 'jpg' ? 'jpeg' : ext === 'tif' ? 'tiff' : ext;
      const out = await encodeDocument(e, { ...loadSettings(), format: format as any });
      return { blob: new Blob([out.bytes.buffer as ArrayBuffer], { type: out.mime }), name: s.fileName || `${doc.name}.${ext}`, isRaster: true };
    } catch {
      // Fallback to project serialization if raster encoding fails
    }
  }
  const blob = await serialize(doc, s.assets);
  const name = projectName(s.fileName?.replace(/\.[^.]+$/, '') || doc.name);
  return { blob, name, isRaster: false };
}

/** Save the project or image to its path/handle, or prompt where to save. */
export async function save(e: Editor) {
  if (e.session.saveHandler) return e.session.saveHandler();
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
  const { blob, name } = await prepareSavePayload(e, s, doc);

  // 1. Existing local file handle
  if (s.fileHandle) {
    try {
      const writable = await s.fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      markLocalSaved(e, s, doc, s.fileHandle.name, blob);
      e.message(`Saved ${s.fileHandle.name}`);
      return;
    } catch (error) {
      console.warn('Failed to write to fileHandle, falling back:', error);
    }
  }

  // 2. Existing Puter cloud path
  if (s.storage.path) {
    try {
      const item = await cloudWrite(s.storage.path, blob);
      markSaved(e, s, doc, item, blob);
      e.message(`Saved ${item.name} to Puter`);
      return;
    } catch (error) {
      console.warn('Failed to write to Puter, falling back:', error);
    }
  }

  // 3. First save: choose Puter if in Puter app/signed in, else local save
  await saveAs(e, false, blob, name);
}

export async function saveAs(e: Editor, copy = false, explicitBlob?: Blob, explicitName?: string) {
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
  const { blob, name } = explicitBlob && explicitName ? { blob: explicitBlob, name: explicitName } : await prepareSavePayload(e, s, doc);

  const isPuterActive = typeof window !== 'undefined' && !!window.puter && (window.puter.env === 'app' || !!window.puter.auth?.isSignedIn?.());

  if (isPuterActive) {
    try {
      e.release();
      const item = await cloudSaveAs(blob, name);
      if (item?.path) {
        if (copy) {
          noteRecent(e, item.name, { kind: 'puter', path: item.path });
          e.message(`Saved a copy as ${item.name}`);
          return;
        }
        markSaved(e, s, doc, item, blob);
        e.message(`Saved ${item.name} to Puter`);
        return;
      }
    } catch (error) {
      console.warn('Puter save failed, falling back to local file picker:', error);
    }
  }

  // Local File System Access API
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      e.release();
      const ext = (name.split('.').pop() || '').toLowerCase();
      const pickerOpts: any = { suggestedName: name };
      if (ext === 'png') pickerOpts.types = [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }];
      else if (ext === 'jpg' || ext === 'jpeg') pickerOpts.types = [{ description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }];
      else if (ext === 'webp') pickerOpts.types = [{ description: 'WebP Image', accept: { 'image/webp': ['.webp'] } }];
      else pickerOpts.types = [{ description: 'Photo Studio Project', accept: { 'application/x-photo-editor': ['.photo'] } }, { description: 'PNG Image', accept: { 'image/png': ['.png'] } }];

      const handle = await (window as any).showSaveFilePicker(pickerOpts);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      if (copy) {
        noteRecent(e, handle.name, { kind: 'local', blob, handle });
        e.message(`Saved a copy as ${handle.name}`);
        return;
      }
      s.fileHandle = handle;
      markLocalSaved(e, s, doc, handle.name, blob);
      e.message(`Saved ${handle.name}`);
      return;
    } catch (error: any) {
      // In Save As mode, if the user explicitly cancelled, we can respect it if interactive,
      // but if Save was clicked, ensure fallback download saves the work.
      if (copy && error?.name === 'AbortError') return;
      console.warn('showSaveFilePicker unavailable or dismissed, saving via download:', error);
    }
  }

  // Fallback to browser download
  e.release();
  download(blob, name);
  if (copy) {
    noteRecent(e, name, { kind: 'local', blob });
    e.message(`Saved a copy as ${name}`);
    return;
  }
  markLocalSaved(e, s, doc, name, blob);
  e.message(`Saved ${name}`);
}
export async function downloadProject(e: Editor) {
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
  const name = projectName(s.fileName?.replace(/\.[^.]+$/, '') || doc.name);
  const blob = await serialize(doc, s.assets);
  download(blob, name);
  s.saved = doc;
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  e.message(`Downloaded ${name}`);
  void emitAppEvent('after-save', s);
}

export function openFromCloud(e: Editor) {
  e.release();
  void pickCloudFiles(true)
    .then((items) =>
      e.run(async () => {
        for (const item of items) await openFile(e, await item.read(), item.name, false, { source: { kind: 'puter', path: item.path } });
      }),
    )
    .catch((error) => e.message(errorText(error)));
}

/** Open a file from the recent list. */
export async function openRecentEntry(e: Editor, entry: { name: string; source: RecentSource }) {
  const src = entry.source;
  const blob = src.kind === 'puter' ? await cloudRead(src.path) : src.kind === 'stored' ? await storedBlob(src.key) : src.blob;
  await openFile(e, blob, entry.name, false, { source: src });
}
export function installRecentOpener() {
  setRecentOpener(openRecentEntry);
}

export function installPuterLaunch(e: Editor) {
  if (typeof window !== 'undefined' && (window as any).puter?.ui?.onLaunchedWithItems) {
    try {
      (window as any).puter.ui.onLaunchedWithItems(async (items: any[]) => {
        for (const item of items) {
          try {
            const blob = await item.read();
            await openFile(e, blob, item.name, false, { source: { kind: 'puter', path: item.path } });
          } catch (err) {
            console.error('Failed to open launched item:', err);
          }
        }
      });
    } catch {
      /* Puter launch handler optional */
    }
  }
}
