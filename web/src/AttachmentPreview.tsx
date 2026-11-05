import { useEffect, useState } from "react";

export function AttachmentPreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ image?: string; text?: string }>({});
  useEffect(() => {
    let cancelled = false;
    const reader = new FileReader();
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      reader.onload = () => { if (!cancelled) setPreview({ image: String(reader.result) }); };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("text/") || /\.(txt|md|json|csv|log|ts|tsx|js|py|yaml|yml)$/i.test(file.name)) {
      void file.slice(0, 8000).text().then(text => { if (!cancelled) setPreview({ text }); });
    }
    return () => { cancelled = true; if (reader.readyState === FileReader.LOADING) reader.abort(); };
  }, [file]);
  return <details className="text-xs max-w-xs">
    <summary className="cursor-pointer">Preview {file.name} ({file.size} bytes)</summary>
    {preview.image && <img src={preview.image} alt={file.name} className="max-h-48 object-contain" />}
    {preview.text !== undefined && <pre className="whitespace-pre-wrap max-h-48 overflow-auto">{preview.text}{file.size > 8000 ? "\nPreview truncated" : ""}</pre>}
    {!preview.image && preview.text === undefined && <p>Preview unavailable for this file type.</p>}
  </details>;
}
