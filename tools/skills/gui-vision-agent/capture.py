#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Three screenshot methods for auditing the Windows desktop -- the "see what is
on screen" half of the perception-action loop.

  1) full   : entire virtual desktop (all windows overlaid + taskbar) via BitBlt
  2) window : a specific top-level window via PrintWindow (sees OCCLUDED content
              -- PrintWindow asks the window to paint itself into our DC, so
              windows stacked on top do not hide it)
  3) list   : enumerate visible top-level windows (HWND / title / class / rect /
              PID) so you know what exists before you screenshot it

Usage:
  python capture.py --list
  python capture.py --full out.png
  python capture.py --window "TrafficMonitor" out.png
  python capture.py --hwnd 12345 out.png

Requires Windows + Pillow. Importing gui_agent sets per-monitor DPI awareness
so captured pixels == input coordinates.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import sys

from PIL import Image

# Reuse gui_agent's DPI awareness + Screen + blit constants.
from gui_agent import Screen, SRCCOPY, CAPTUREBLT

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# Set argtypes so 64-bit handles (HWND/HDC) are NOT truncated to 32-bit when
# passed through ctypes' default int conversion.
user32.GetWindowDC.argtypes = [wt.HWND]
user32.GetWindowDC.restype = wt.HANDLE
user32.ReleaseDC.argtypes = [wt.HWND, wt.HANDLE]
user32.ReleaseDC.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetWindowRect.restype = ctypes.c_int
user32.PrintWindow.argtypes = [wt.HWND, wt.HANDLE, wt.UINT]
user32.PrintWindow.restype = wt.BOOL
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.IsWindowVisible.restype = wt.BOOL
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(ctypes.c_ulong)]
user32.GetWindowThreadProcessId.restype = ctypes.c_ulong
gdi32.CreateCompatibleDC.argtypes = [wt.HANDLE]
gdi32.CreateCompatibleDC.restype = wt.HANDLE
gdi32.CreateCompatibleBitmap.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wt.HANDLE
gdi32.SelectObject.argtypes = [wt.HANDLE, wt.HANDLE]
gdi32.SelectObject.restype = wt.HANDLE
gdi32.GetDIBits.argtypes = [wt.HANDLE, wt.HANDLE, ctypes.c_uint, ctypes.c_uint,
                            ctypes.c_void_p, ctypes.c_void_p, wt.UINT]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wt.HANDLE]
gdi32.DeleteObject.restype = ctypes.c_int
gdi32.DeleteDC.argtypes = [wt.HANDLE]
gdi32.DeleteDC.restype = ctypes.c_int


def _bitmap_header(w: int, h: int) -> "ctypes.Structure":
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG),
                    ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                    ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                    ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                    ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                    ("biClrImportant", wt.DWORD)]
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth, bi.biHeight = w, -h        # negative => top-down
    bi.biPlanes, bi.biBitCount = 1, 32
    bi.biCompression = 0
    return bi


def _read_dc(dst, bmp, w: int, h: int, path: str) -> str:
    buf = ctypes.create_string_buffer(w * h * 4)
    bi = _bitmap_header(w, h)
    gdi32.GetDIBits(dst, bmp, 0, h, buf, ctypes.byref(bi), 0)
    img = Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1)
    img.save(path)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(dst)
    return path


# --------------------------------------------------------------------------
#  1) full virtual desktop
# --------------------------------------------------------------------------
def capture_full(path: str) -> str:
    """Capture the entire virtual desktop (all monitors) including layered
    windows and the taskbar. Good for seeing every window overlaid."""
    s = Screen()
    img = s.capture()            # defaults to the whole virtual desktop
    img.save(path)
    return path


# --------------------------------------------------------------------------
#  2) a specific window (PrintWindow, sees occluded content)
# --------------------------------------------------------------------------
def find_window(substr: str) -> "int | None":
    target = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        b = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, b, n + 1)
        if substr.lower() in b.value.lower():
            target.append(int(hwnd))
            return False
        return True

    user32.EnumWindows(cb, 0)
    return target[0] if target else None


def capture_window(hwnd: int, path: str) -> str:
    """Capture one window by HWND using PrintWindow. Because the window paints
    itself into our offscreen DC, content hidden behind other windows is still
    captured. PW_RENDERFULLCONTENT (2) is used when available (Win8+)."""
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w = max(1, r.right - r.left)
    h = max(1, r.bottom - r.top)
    src = user32.GetWindowDC(hwnd)
    dst = gdi32.CreateCompatibleDC(src)
    bmp = gdi32.CreateCompatibleBitmap(src, w, h)
    gdi32.SelectObject(dst, bmp)
    if not user32.PrintWindow(hwnd, dst, 2):     # 2 = PW_RENDERFULLCONTENT
        user32.PrintWindow(hwnd, dst, 0)
    _read_dc(dst, bmp, w, h, path)
    user32.ReleaseDC(hwnd, src)
    return path


# --------------------------------------------------------------------------
#  3) list visible top-level windows
# --------------------------------------------------------------------------
def list_windows():
    rows = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, b, n + 1)
            title = b.value
        if not title:
            return True
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rows.append((pid.value, int(hwnd), title, cls.value,
                     r.left, r.top, r.right, r.bottom))
        return True

    user32.EnumWindows(cb, 0)
    return rows


def main() -> None:
    p = argparse.ArgumentParser(description="Three Windows screenshot methods")
    p.add_argument("--list", action="store_true",
                   help="list visible top-level windows (HWND/title/class/rect/PID)")
    p.add_argument("--full", metavar="PATH",
                   help="capture the whole virtual desktop (overlaid + taskbar)")
    p.add_argument("--window", metavar="TITLE",
                   help="capture a window by title substring, via PrintWindow")
    p.add_argument("--hwnd", type=int,
                   help="capture a window by HWND, via PrintWindow")
    p.add_argument("--out", help="output path for --window/--hwnd")
    a = p.parse_args()

    if a.list:
        rows = list_windows()
        print(f"{'PID':>7}  {'HWND':>10}  {'x':>5} {'y':>5} {'r':>5} {'b':>5}  title [class]")
        for pid, hwnd, title, cls, l, t, rt, b in rows:
            print(f"{pid:>7}  {hwnd:>10}  {l:>5} {t:>5} {rt:>5} {b:>5}  {title!r} [{cls}]")
        return

    if a.full:
        print("full ->", capture_full(a.full))
        return

    if a.window:
        hwnd = find_window(a.window)
        if hwnd is None:
            print(f"window not found: {a.window!r}")
            sys.exit(2)
        out = a.out or f"window_{hwnd}.png"
        print(f"window {a.window!r} (hwnd={hwnd}) -> {capture_window(hwnd, out)}")
        return

    if a.hwnd:
        out = a.out or f"window_{a.hwnd}.png"
        print(f"hwnd {a.hwnd} -> {capture_window(a.hwnd, out)}")
        return

    p.print_help()


if __name__ == "__main__":
    main()
