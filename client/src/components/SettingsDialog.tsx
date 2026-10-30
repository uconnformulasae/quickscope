import { useState, useEffect, useRef } from 'react';
import { Save } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { getSettings, updateSettings, type Settings } from '../lib/api';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings>({
    aim_wifi_ssid: '',
    aim_device_ip: '10.0.0.1',
    aim_device_port: 2000,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(e => setError(e.message));
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload = {
        ...settings,
        aim_device_port: settings.aim_device_port || 2000,
      };
      await updateSettings(payload);
      setSettings(payload);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
          {/* AiM */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              AiM Device
            </h3>
            <div className="space-y-2">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">WiFi SSID</label>
                <input
                  type="text"
                  value={settings.aim_wifi_ssid}
                  onChange={e => setSettings({ ...settings, aim_wifi_ssid: e.target.value })}
                  placeholder="AiM-EVO5-00740-UConn-EV"
                  className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-muted-foreground mb-1">Device IP</label>
                  <input
                    type="text"
                    value={settings.aim_device_ip}
                    onChange={e => setSettings({ ...settings, aim_device_ip: e.target.value })}
                    className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs text-muted-foreground mb-1">Port</label>
                  <input
                    type="number"
                    value={settings.aim_device_port === 0 ? '' : settings.aim_device_port}
                    onChange={e => setSettings({ ...settings, aim_device_port: e.target.value === '' ? 0 : parseInt(e.target.value, 10) || 0 })}
                    placeholder="2000"
                    className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Error / Success */}
          {error && (
            <p className="text-xs text-danger">{error}</p>
          )}
          {saved && (
            <p className="text-xs text-success">Settings saved.</p>
          )}
      </div>
    </Sheet>
  );
}
