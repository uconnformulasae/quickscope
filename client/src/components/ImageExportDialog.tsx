import { useEffect, useState, useCallback } from 'react';
import { X, ImageDown, Download, Copy, Check } from 'lucide-react';
import { renderChartImage, type ChartExportSpec, type ChartExportResult } from '../lib/chart-export';

interface ImageExportDialogProps {
  spec: ChartExportSpec;
  onClose: () => void;
}

/** Preview of the exported chart image with Download PNG / Copy to clipboard. */
export function ImageExportDialog({ spec, onClose }: ImageExportDialogProps) {
  const [result, setResult] = useState<ChartExportResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Render once per spec (the spec is a snapshot taken when the button was clicked)
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setResult(null);
    setUrl(null);
    setError(null);
    renderChartImage(spec)
      .then(r => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.blob);
        setResult(r);
        setUrl(objectUrl);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [spec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = useCallback(() => {
    if (!result || !url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [result, url]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })]);
      setCopyState('copied');
    } catch (err) {
      console.error('Copy image failed:', err);
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  }, [result]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-5xl mx-4 flex flex-col overflow-hidden"
        style={{ maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
        data-testid="image-export-dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ImageDown className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="text-sm font-semibold text-foreground flex-shrink-0">Save image</span>
            {result && (
              <span className="text-xs text-muted-foreground font-mono truncate ml-2" title={result.fileName}>
                {result.fileName}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0 overflow-auto p-4 bg-background flex items-center justify-center">
          {url ? (
            <img
              src={url}
              alt="Chart export preview"
              className="max-w-full h-auto rounded-md border border-border"
              style={{ maxHeight: '68vh' }}
            />
          ) : error ? (
            <p className="text-xs text-destructive py-16">Could not render image: {error}</p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-16">
              <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="text-xs text-muted-foreground">Rendering…</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border flex-shrink-0 bg-muted/10">
          <div className="text-xs text-muted-foreground">
            {result
              ? `${result.width} × ${result.height} at ${result.pixelRatio}x (${result.width * result.pixelRatio} × ${result.height * result.pixelRatio} px PNG)`
              : ' '}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              disabled={!result}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-border"
              data-testid="copy-image"
            >
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy to clipboard'}
            </button>
            <button
              onClick={handleDownload}
              disabled={!result}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="download-image"
            >
              <Download className="w-3.5 h-3.5" />
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
