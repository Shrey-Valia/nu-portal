import { execFile } from "node:child_process";

// macOS notification. Text goes in as argv, never interpolated into the script,
// so posting-derived text can't inject AppleScript.
export function notify(title: string, message: string, subtitle = ""): Promise<void> {
  if (process.platform !== "darwin" || process.env.NUPORTAL_QUIET === "1") return Promise.resolve();
  const script = [
    "on run argv",
    "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
    "end run",
  ];
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", [...script.flatMap((l) => ["-e", l]), title.slice(0, 120), message.slice(0, 240), subtitle.slice(0, 120)], () => resolve());
  });
}
