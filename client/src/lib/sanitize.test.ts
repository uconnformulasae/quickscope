import { describe, expect, it } from 'vitest';
import {
  normalizeSettings,
  stripInvisible,
  validateDeviceIp,
  validateDevicePort,
  validateSettings,
  validateWifiSsid,
} from './sanitize';

describe('stripInvisible', () => {
  it.each([
    ['a\u0000b', 'ab'],
    ['line1\nline2', 'line1line2'],
    ['rtl\u202eoverride', 'rtloverride'],
    ['zero\u200bwidth', 'zerowidth'],
    ['Café ⚡ 速度', 'Café ⚡ 速度'],
  ])('%j -> %j', (raw, expected) => {
    expect(stripInvisible(raw)).toBe(expected);
  });
});

describe('validateDeviceIp', () => {
  it.each(['10.0.0.1', ' 192.168.4.1 ', '0.0.0.0', '255.255.255.255', '::1', 'fe80::1'])(
    'accepts %j', (ip) => {
      expect(validateDeviceIp(ip)).toBeNull();
    },
  );

  it.each([
    '', 'evil.example.com', '10.0.0.256', '10.0.0', '10.0.0.1:2000', '01.0.0.1',
    '10.0.0.1; reboot', 'http://10.0.0.1', '[::1]', '::1/64', 'user@::1',
  ])('rejects %j', (ip) => {
    expect(validateDeviceIp(ip)).toMatch(/IP address/);
  });
});

describe('validateDevicePort', () => {
  it.each([1, 2000, 65535])('accepts %d', (port) => {
    expect(validateDevicePort(port)).toBeNull();
  });

  it.each([0, -1, 65536, 2000.5, Number.NaN])('rejects %d', (port) => {
    expect(validateDevicePort(port)).toMatch(/between 1 and 65535/);
  });
});

describe('validateWifiSsid', () => {
  it('accepts empty and normal names', () => {
    expect(validateWifiSsid('')).toBeNull();
    expect(validateWifiSsid('AiM-EVO5-00740-UConn-EV')).toBeNull();
  });

  it('counts bytes, not characters (802.11 limit is 32 bytes)', () => {
    expect(validateWifiSsid('x'.repeat(32))).toBeNull();
    expect(validateWifiSsid('x'.repeat(33))).toMatch(/too long/);
    expect(validateWifiSsid('é'.repeat(17))).toMatch(/too long/); // 34 bytes
  });

  it('ignores invisible characters when measuring', () => {
    expect(validateWifiSsid('x'.repeat(32) + '\n\u200b')).toBeNull();
  });
});

describe('validateSettings / normalizeSettings', () => {
  const good = { aim_wifi_ssid: 'Car', aim_device_ip: '10.0.0.1', aim_device_port: 2000 };

  it('returns null for valid settings', () => {
    expect(validateSettings(good)).toBeNull();
  });

  it('reports the first problem', () => {
    expect(validateSettings({ ...good, aim_device_ip: 'nope' })).toMatch(/IP address/);
    expect(validateSettings({ ...good, aim_device_port: 99999 })).toMatch(/port/);
  });

  it('trims and strips invisible characters', () => {
    expect(normalizeSettings({ aim_wifi_ssid: ' Car\nNet ', aim_device_ip: ' 10.0.0.1 ', aim_device_port: 2000 }))
      .toEqual({ aim_wifi_ssid: 'CarNet', aim_device_ip: '10.0.0.1', aim_device_port: 2000 });
  });
});
