import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { getSettings, updateSettings, type Settings } from '../lib/api';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings>({
    railway_url: '',
    aim_wifi_ssid: '',
    aim_device_ip: '10.0.0.1',
    aim_device_port: 2000,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(e => setError(e.message));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {/* Railway */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Data-Development (Railway)
            </h3>
            <label className="block text-xs text-muted-foreground mb-1">API URL</label>
            <input
              type="text"
              value={settings.railway_url}
              onChange={e => setSettings({ ...settings, railway_url: e.target.value })}
              placeholder="https://your-app.railway.app/api/v1"
              className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
            />
          </div>

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
                    value={settings.aim_device_port}
                    onChange={e => setSettings({ ...settings, aim_device_port: parseInt(e.target.value) || 2000 })}
                    className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Error / Success */}
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
          {saved && (
            <p className="text-xs text-emerald-400">Settings saved.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
