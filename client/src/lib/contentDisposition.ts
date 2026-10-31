/** Parse filename="..." from a Content-Disposition header value. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const quoted = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(header);
  if (quoted) {
    const raw = quoted[1] ?? quoted[2];
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const unquoted = /filename=([^;]+)/i.exec(header);
  return unquoted ? unquoted[1].trim() : null;
}
