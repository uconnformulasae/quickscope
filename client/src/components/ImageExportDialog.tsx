import { useEffect, useState, useCallback } from 'react';
import { Download, Copy, Check } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
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
    <Sheet
      title="Save image"
      subtitle={
        result ? (
          <span className="font-mono truncate block" title={result.fileName}>{result.fileName}</span>
        ) : undefined
      }
      onClose={onClose}
      width={760}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {result
              ? `${result.width} × ${result.height} at ${result.pixelRatio}x (${result.width * result.pixelRatio} × ${result.height * result.pixelRatio} px PNG)`
              : ' '}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={handleCopy}
              disabled={!result}
              data-testid="copy-image"
            >
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy to clipboard'}
            </Button>
            <Button
              variant="primary"
              onClick={handleDownload}
              disabled={!result}
              data-testid="download-image"
            >
              <Download className="w-3.5 h-3.5" />
              Download PNG
            </Button>
          </div>
        </div>
      }
    >
      <div data-testid="image-export-dialog" className="flex items-center justify-center">
          {url ? (
            <img
              src={url}
              alt="Chart export preview"
              className="max-w-full h-auto rounded-md border border-border"
              style={{ maxHeight: '68vh' }}
            />
          ) : error ? (
            <p className="text-xs text-danger py-16">Could not render image: {error}</p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-16">
              <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="text-xs text-muted-foreground">Rendering…</p>
            </div>
          )}
      </div>
    </Sheet>
  );
}
