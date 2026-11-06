import { execFile } from "node:child_process";

export type DesktopNotice = { title: string; body: string };
// Fixed scripts receive data separately: labels can never become executable commands.
export async function desktopNotify(notice: DesktopNotice): Promise<void> {
  if (process.env.VITEST) return;
  let file: string, args: string[];
  const env = { ...process.env, RIVET_NOTICE_TITLE: notice.title, RIVET_NOTICE_BODY: notice.body };
  if (process.platform === "win32") {
    file = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-Command", 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; try { $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(4000, $env:RIVET_NOTICE_TITLE, $env:RIVET_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Milliseconds 4500 } finally { $n.Dispose() }'];
  } else if (process.platform === "darwin") {
    file = "osascript";
    args = ["-e", 'on run argv', "-e", 'display notification (item 2 of argv) with title (item 1 of argv)', "-e", 'end run', notice.title, notice.body];
  } else { file = "notify-send"; args = ["--app-name=Rivet", "--", notice.title, notice.body]; }
  await new Promise<void>((resolve,reject) => execFile(file,args,{env,windowsHide:true,timeout:10_000},error=>error?reject(error):resolve()));
}
