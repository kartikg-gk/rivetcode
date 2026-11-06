import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { openTerminal } from "./api";

export function TerminalPane({ id, session }: { id: string; session: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string>();
  useEffect(() => {
    setNote(undefined);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const term = new Terminal({ fontSize: 13, convertEol: false, theme: dark ? { background: "#0b0b0b" } : { background: "#ffffff", foreground: "#1a1f23", cursor: "#1a1f23" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const link = openTerminal(`${id}-${session}`, (m) => {
      if (m.type === "output") term.write(m.data);
      else if (m.type === "exit") setNote("This terminal has ended.");
      else if (m.type === "error") setNote(m.error);
    });
    const resize = () => { try { fit.fit(); link.resize(term.cols, term.rows); } catch { /* hidden */ } };
    const typing = term.onData((d) => link.input(d));
    const seen = new ResizeObserver(resize);
    seen.observe(host.current!);
    resize();
    return () => { seen.disconnect(); typing.dispose(); link.close(); term.dispose(); };
  }, [id, session]);
  return (
    <div className="h-full flex flex-col min-h-0">
      {note && <p className="p-2 text-sm text-muted">{note}</p>}
      <div ref={host} className="flex-1 min-h-0 p-1" aria-label="Terminal" />
    </div>
  );
}
