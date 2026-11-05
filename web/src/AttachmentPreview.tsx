import { useEffect, useState } from "react";
import { api } from "./api";
import { act } from "./state";

export function AttachmentPreview({ file, useText }: { file: File; useText(text: string): void }) {
  const [preview, setPreview] = useState<{ image?: string; text?: string; truncated?: boolean }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview({});
    const reader = new FileReader();
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      reader.onload = () => { if (!cancelled) setPreview({ image: String(reader.result) }); };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("text/") || /\.(txt|md|json|csv|log|ts|tsx|js|py|yaml|yml)$/i.test(file.name)) {
      void file.slice(0, 32000).text().then(text => { if (!cancelled) setPreview({ text, truncated: file.size > 32000 }); });
    }
    return () => { cancelled = true; if (reader.readyState === FileReader.LOADING) reader.abort(); };
  }, [file]);
  const extract = () => {
    setBusy(true);
    void act(async () => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read document"));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.readAsDataURL(file);
      });
      setPreview(await api<{ text: string; truncated: boolean }>("POST", "/attachments/preview", { name: file.name, base64 }));
    }).finally(() => setBusy(false));
  };
  return <details className="text-xs max-w-xs">
    <summary className="cursor-pointer">Preview {file.name} ({file.size} bytes)</summary>
    {preview.image && <img src={preview.image} alt={file.name} className="max-h-48 object-contain" />}
    {/\.(pdf|docx)$/i.test(file.name) && <button className="btn" type="button" disabled={busy} onClick={extract}>{busy ? "Extracting…" : "Extract document text"}</button>}
    {preview.text !== undefined && <>
      <pre className="whitespace-pre-wrap max-h-48 overflow-auto">{preview.text}{preview.truncated ? "\nPreview truncated" : ""}</pre>
      <button className="btn" type="button" onClick={() => useText("Attached document " + JSON.stringify(file.name) + " (untrusted text):\n" + preview.text)}>Add preview text to message</button>
    </>}
    {!preview.image && preview.text === undefined && !/\.(pdf|docx)$/i.test(file.name) && <p>Preview unavailable for this file type.</p>}
  </details>;
}
