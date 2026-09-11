#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Minimize all visible top-level windows except shell/explorer/task manager.
Used as a pre-step before gui_agent.py so the actual desktop is visible."""
import ctypes, ctypes.wintypes as wt, sys, time

user32 = ctypes.WinDLL("user32", use_last_error=True)
SW_MINIMIZE, SW_RESTORE = 6, 9

EXCLUDE_TITLE = ["", "Program Manager", "Windows 输入体验", "Microsoft Text Input Application"]
EXCLUDE_CLASS = ["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "WorkerW", "Progman"]

def main():
    proto = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    minimized = []

    @proto
    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        title_buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title_buf, 512)
        title = title_buf.value
        if not title or title in EXCLUDE_TITLE:
            return True
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        cls = cls_buf.value
        if cls in EXCLUDE_CLASS:
            return True
        # Also keep small utility windows / own agent windows if any
        if "trafficmonitor" in title.lower():
            return True
        user32.ShowWindow(hwnd, SW_MINIMIZE)
        minimized.append((title, cls))
        return True

    user32.EnumWindows(cb, 0)
    print(f"Minimized {len(minimized)} windows")
    for t, c in minimized[:20]:
        print(f"  - {t!r} ({c})")
    time.sleep(0.5)
    return 0

if __name__ == "__main__":
    sys.exit(main())
