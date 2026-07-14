/**
 * Wall-clock time formatting for chart display.
 *
 * Sample timestamps stay session-relative (0..durationMs). Only axis labels,
 * cursors, and range readouts add the log start offset for display.
 */

import { formatTimeSec } from './chart-utils';
import { formatTime } from './xrk-parser';

const DATE_SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isValidDate(year: number, month: number, day: number): boolean {
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  const trimmed = dateStr.trim();
  const slash = trimmed.match(DATE_SLASH);
  if (slash) {
    const dmy = { year: +slash[3], month: +slash[2], day: +slash[1] };
    if (isValidDate(dmy.year, dmy.month, dmy.day)) return dmy;
    const mdy = { year: +slash[3], month: +slash[1], day: +slash[2] };
    if (isValidDate(mdy.year, mdy.month, mdy.day)) return mdy;
    return null;
  }
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const parts = { year: +iso[1], month: +iso[2], day: +iso[3] };
    return isValidDate(parts.year, parts.month, parts.day) ? parts : null;
  }
  const dash = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) {
    const parts = { year: +dash[3], month: +dash[2], day: +dash[1] };
    return isValidDate(parts.year, parts.month, parts.day) ? parts : null;
  }
  return null;
}

function parseTimeParts(timeStr: string): { hour: number; minute: number; second: number } {
  const trimmed = timeStr.trim();
  const withSec = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (withSec) {
    return { hour: +withSec[1], minute: +withSec[2], second: +withSec[3] };
  }
  const hm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    return { hour: +hm[1], minute: +hm[2], second: 0 };
  }
  return { hour: 0, minute: 0, second: 0 };
}

/** Parse AiM Log Date + Log Time into epoch milliseconds (local time). */
export function parseLogStartMs(dateStr: string, timeStr: string): number | null {
  if (!dateStr || dateStr === 'Unknown') return null;
  const date = parseDateParts(dateStr);
  if (!date) return null;
  const { hour, minute, second } = parseTimeParts(timeStr || '00:00:00');
  const ms = new Date(date.year, date.month - 1, date.day, hour, minute, second).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function resolveLogStartMs(
  recordedAt?: string | null,
  date?: string,
  time?: string,
): number | null {
  if (recordedAt) {
    const ms = Date.parse(recordedAt);
    if (!Number.isNaN(ms)) return ms;
  }
  return parseLogStartMs(date ?? '', time ?? '');
}

function formatWallClock(
  d: Date,
  options: { includeMs?: boolean } = {},
): string {
  const h = d.getHours();
  const hour12 = h % 12 || 12;
  const minute = d.getMinutes().toString().padStart(2, '0');
  const second = d.getSeconds().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (options.includeMs) {
    const ms = d.getMilliseconds();
    return `${hour12}:${minute}:${second}.${ms.toString().padStart(3, '0')} ${ampm}`;
  }
  return `${hour12}:${minute}:${second} ${ampm}`;
}

/** Format elapsed seconds for the chart x-axis (wall clock when log start is known). */
export function formatChartAxisTime(
  elapsedSec: number,
  logStartMs: number | null,
  tickStep?: number,
): string {
  if (logStartMs === null) {
    return formatTimeSec(elapsedSec, tickStep);
  }

  const d = new Date(logStartMs + elapsedSec * 1000);
  if (tickStep !== undefined && tickStep >= 3600) {
    const h = d.getHours();
    const hour12 = h % 12 || 12;
    const minute = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${hour12}:${minute} ${ampm}`;
  }
  if (tickStep !== undefined && tickStep >= 60) {
    const h = d.getHours();
    const hour12 = h % 12 || 12;
    const minute = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${hour12}:${minute} ${ampm}`;
  }
  if (tickStep !== undefined && tickStep < 1) {
    return formatWallClock(d, { includeMs: true });
  }
  return formatWallClock(d);
}

/** Format time for cursor / hover readouts — always includes seconds and ms. */
export function formatChartCursorTime(
  elapsedSec: number,
  logStartMs: number | null,
): string {
  if (logStartMs === null) {
    return formatTimeSec(elapsedSec, 0.001);
  }
  const elapsedMs = Math.round(elapsedSec * 1000);
  return formatWallClock(new Date(logStartMs + elapsedMs), { includeMs: true });
}

/** Format session-relative milliseconds for toolbar / readouts. */
export function formatChartElapsed(
  elapsedMs: number,
  logStartMs: number | null,
): string {
  if (logStartMs === null) {
    return formatTime(elapsedMs);
  }
  return formatWallClock(new Date(logStartMs + elapsedMs));
}
