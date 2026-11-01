import type { LocalSession } from './api';

/** Filename without extension. */
export function pathStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Label shown in the session browser list (matches SessionBrowser UI). */
export function quickscopeSessionDisplayName(
  session: Pick<LocalSession, 'aim_session_id' | 'filename'>,
): string {
  const id = session.aim_session_id?.trim();
  if (id) return id;
  return session.filename;
}

/** Base name for exported `.xrk` / `_export.csv` files (no extension). */
export function quickscopeSessionExportBaseName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return 'export';
  return trimmed.replace(/\.(xrk|xrz)$/i, '') || trimmed;
}

export function sanitizeExportFilePart(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._+-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'export'
  );
}

export function quickscopeSessionExportFileBase(
  session: Pick<LocalSession, 'aim_session_id' | 'filename'>,
): string {
  return sanitizeExportFilePart(
    quickscopeSessionExportBaseName(quickscopeSessionDisplayName(session)),
  );
}
