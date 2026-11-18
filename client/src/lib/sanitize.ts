/**
 * Client-side input validation, mirroring backend/sanitize.py.
 *
 * The backend is the authority (it rejects bad values with a 400); these give
 * the user immediate feedback instead of a round-trip. Each validator returns
 * an error message, or null when the value is acceptable.
 */

import type { Settings } from './api';

export const MAX_SSID_BYTES = 32; // IEEE 802.11 limit

// Control characters, zero-width characters and bidi overrides (same set as the backend).
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

/** Remove control, zero-width and bidi-override characters. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, '');
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || /[[\]/?#@\s]/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function validateDeviceIp(value: string): string | null {
  const v = value.trim();
  if (IPV4_RE.test(v) || isIpv6(v)) return null;
  return 'Device IP must be an IP address like 10.0.0.1';
}

export function validateDevicePort(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return 'Device port must be between 1 and 65535';
  }
  return null;
}

export function validateWifiSsid(value: string): string | null {
  const bytes = new TextEncoder().encode(stripInvisible(value).trim()).length;
  if (bytes > MAX_SSID_BYTES) return `WiFi network name is too long (max ${MAX_SSID_BYTES} bytes)`;
  return null;
}

/** First problem with the AiM settings, or null if they can be saved. */
export function validateSettings(s: Settings): string | null {
  return validateWifiSsid(s.aim_wifi_ssid)
    ?? validateDeviceIp(s.aim_device_ip)
    ?? validateDevicePort(s.aim_device_port);
}

/** Settings as they should be sent: trimmed, invisible characters removed. */
export function normalizeSettings(s: Settings): Settings {
  return {
    aim_wifi_ssid: stripInvisible(s.aim_wifi_ssid).trim(),
    aim_device_ip: s.aim_device_ip.trim(),
    aim_device_port: s.aim_device_port,
  };
}
