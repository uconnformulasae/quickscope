type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;

/** Download a blob straight to the browser's downloads folder. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    downloadUrl(url, fileName);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Download something that already has a URL (e.g. an object URL also shown in an <img>). */
export function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Save a blob with the system save dialog when available, otherwise trigger a download.
 */
export async function saveBlob(blob: Blob, suggestedName: string): Promise<void> {
  const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()!.toLowerCase() : '';
  const accept: Record<string, string[]> = {};
  if (ext) {
    accept['application/octet-stream'] = [`.${ext}`];
  }

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const showSaveFilePicker = (window as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker;
      const handle = await showSaveFilePicker({
        suggestedName,
        ...(ext
          ? {
              types: [
                {
                  description: ext.toUpperCase(),
                  accept,
                },
              ],
            }
          : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
    }
  }

  downloadBlob(blob, suggestedName);
}
