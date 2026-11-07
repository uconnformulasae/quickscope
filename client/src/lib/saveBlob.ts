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
      const handle = await window.showSaveFilePicker({
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

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
