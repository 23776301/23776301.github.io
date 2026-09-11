#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
 Universal GUI Agent  --  powered by ByteDance UI-TARS-1.5 (local, llama.cpp)
================================================================================

A GENERAL-PURPOSE desktop automation agent. It contains ZERO application
specific logic. It looks at the screen, asks the UI-TARS vision model what to
do next, and performs that action with real OS-level input.

Because it works purely on pixels + synthetic input, the SAME script drives:
    * native Win32 apps      (TrafficMonitor options, control panel, ...)
    * installers / setup wizards  (PUBG, Steam, drivers, ...)
    * browsers               (click links, fill forms, scroll pages, ...)
    * Electron / UWP / games / anything visible on screen

--------------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------------
    python gui_agent.py "打开记事本并输入 hello world"
    python gui_agent.py --task "在浏览器中搜索 PUBG 官网并点击下载"
    python gui_agent.py --task "安装这个程序，一路下一步，接受协议" --max-steps 40
    python gui_agent.py --task "..." --launch "C:\\Games\\setup.exe"
    python gui_agent.py --task "..." --focus "Chrome"
    python gui_agent.py --task "..." --dry-run          # 只看模型决策，不真的点

--------------------------------------------------------------------------------
ARCHITECTURE
--------------------------------------------------------------------------------
    loop:
        1. Screen.capture()            -> full-screen PNG
        2. resize + base64             -> model input
        3. UITarsClient.act()          -> "Thought: ...\nAction: click(...)"
        4. parse_action()              -> structured action
        5. Executor.run()              -> real SendInput mouse/keyboard
        6. append to history, repeat until finished() / call_user() / max steps

Nothing above knows or cares which program is on screen.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes as wt
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required:  pip install pillow")


# ==============================================================================
#  Win32 plumbing
# ==============================================================================

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

try:
    # Per-monitor DPI aware so pixel coordinates match what we screenshot.
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

SM_CXSCREEN, SM_CYSCREEN = 0, 1
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000  # needed to capture layered / topmost windows

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP = 0x0020, 0x0040
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x0800, 0x1000
MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_VIRTUALDESK = 0x8000, 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTunion)]


def _send(*inputs: INPUT) -> None:
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(INPUT))


def _mouse(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    return INPUT(type=INPUT_MOUSE,
                 u=_INPUTunion(mi=MOUSEINPUT(dx, dy, data, flags, 0, None)))


def _key(vk: int, flags: int = 0, scan: int = 0) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD,
                 u=_INPUTunion(ki=KEYBDINPUT(vk, scan, flags, 0, None)))


# ==============================================================================
#  Screen capture  (application-agnostic)
# ==============================================================================

class Screen:
    """Full virtual-desktop capture. Works for any window, including layered."""

    def __init__(self) -> None:
        self.x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        self.y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        self.w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        self.h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)

    def capture(self, region: Optional[Tuple[int, int, int, int]] = None) -> Image.Image:
        rx, ry, rw, rh = region if region else (self.x, self.y, self.w, self.h)
        src = user32.GetDC(0)
        dst = gdi32.CreateCompatibleDC(src)
        bmp = gdi32.CreateCompatibleBitmap(src, rw, rh)
        old = gdi32.SelectObject(dst, bmp)
        try:
            gdi32.BitBlt(dst, 0, 0, rw, rh, src, rx, ry, SRCCOPY | CAPTUREBLT)
            buf = ctypes.create_string_buffer(rw * rh * 4)

            class BITMAPINFOHEADER(ctypes.Structure):
                _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG),
                            ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                            ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                            ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                            ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                            ("biClrImportant", wt.DWORD)]

            bi = BITMAPINFOHEADER()
            bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bi.biWidth, bi.biHeight = rw, -rh          # negative => top-down
            bi.biPlanes, bi.biBitCount = 1, 32
            bi.biCompression = 0
            gdi32.GetDIBits(dst, bmp, 0, rh, buf, ctypes.byref(bi), 0)
            return Image.frombuffer("RGB", (rw, rh), buf, "raw", "BGRX", 0, 1)
        finally:
            gdi32.SelectObject(dst, old)
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(dst)
            user32.ReleaseDC(0, src)


# ==============================================================================
#  Input execution  (application-agnostic)
# ==============================================================================

VK = {
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10,
    "win": 0x5B, "super": 0x5B, "meta": 0x5B, "cmd": 0x5B,
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "back": 0x08, "delete": 0x2E, "del": 0x2E,
    "insert": 0x2D, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "pgup": 0x21, "pgdn": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "capslock": 0x14, "printscreen": 0x2C, "menu": 0x5D, "apps": 0x5D,
}
for _i in range(1, 25):
    VK[f"f{_i}"] = 0x6F + _i
for _c in "abcdefghijklmnopqrstuvwxyz":
    VK[_c] = ord(_c.upper())
for _c in "0123456789":
    VK[_c] = ord(_c)
VK.update({"-": 0xBD, "=": 0xBB, "[": 0xDB, "]": 0xDD, "\\": 0xDC,
           ";": 0xBA, "'": 0xDE, ",": 0xBC, ".": 0xBE, "/": 0xBF, "`": 0xC0})

EXTENDED = {0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27,
            0x5B, 0x5D, 0x2C}


class Mouse:
    def __init__(self, screen: Screen) -> None:
        self.s = screen

    def _abs(self, x: int, y: int) -> Tuple[int, int]:
        """Screen pixels -> 0..65535 virtual-desktop normalized."""
        nx = int(round((x - self.s.x) * 65535 / max(self.s.w - 1, 1)))
        ny = int(round((y - self.s.y) * 65535 / max(self.s.h - 1, 1)))
        return max(0, min(65535, nx)), max(0, min(65535, ny))

    def move(self, x: int, y: int, settle: float = 0.06) -> None:
        nx, ny = self._abs(x, y)
        flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        _send(_mouse(flags, nx, ny))
        # Second identical move: some shells only latch hover on the 2nd event.
        _send(_mouse(flags, nx, ny))
        time.sleep(settle)

    def click(self, x: int, y: int, button: str = "left", double: bool = False) -> None:
        down, up = {
            "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }[button]
        self.move(x, y)
        times = 2 if double else 1
        for i in range(times):
            _send(_mouse(down))
            time.sleep(0.035)
            _send(_mouse(up))
            if i == 0 and double:
                time.sleep(0.06)
        time.sleep(0.12)

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> None:
        self.move(x1, y1)
        _send(_mouse(MOUSEEVENTF_LEFTDOWN))
        time.sleep(0.12)
        steps = 24
        for i in range(1, steps + 1):
            self.move(int(x1 + (x2 - x1) * i / steps),
                      int(y1 + (y2 - y1) * i / steps), settle=0.012)
        time.sleep(0.12)
        _send(_mouse(MOUSEEVENTF_LEFTUP))
        time.sleep(0.15)

    def scroll(self, x: int, y: int, direction: str, clicks: int = 3) -> None:
        self.move(x, y)
        d = direction.lower()
        for _ in range(clicks):
            if d in ("down", "up"):
                _send(_mouse(MOUSEEVENTF_WHEEL, data=(-120 if d == "down" else 120)))
            else:
                _send(_mouse(MOUSEEVENTF_HWHEEL, data=(120 if d == "right" else -120)))
            time.sleep(0.05)
        time.sleep(0.2)


class Keyboard:
    @staticmethod
    def hotkey(combo: str) -> None:
        keys = [k.strip().lower() for k in combo.replace("+", " ").split() if k.strip()]
        vks = [VK[k] for k in keys if k in VK]
        if not vks:
            raise ValueError(f"unknown hotkey: {combo!r}")
        for vk in vks:
            _send(_key(vk, KEYEVENTF_EXTENDEDKEY if vk in EXTENDED else 0))
            time.sleep(0.02)
        for vk in reversed(vks):
            f = KEYEVENTF_KEYUP | (KEYEVENTF_EXTENDEDKEY if vk in EXTENDED else 0)
            _send(_key(vk, f))
            time.sleep(0.02)
        time.sleep(0.15)

    @staticmethod
    def unicode_text(text: str) -> None:
        for ch in text:
            if ch == "\n":
                Keyboard.hotkey("enter")
                continue
            code = ord(ch)
            for surrogate in ([code] if code <= 0xFFFF else
                              [0xD800 + ((code - 0x10000) >> 10),
                               0xDC00 + ((code - 0x10000) & 0x3FF)]):
                _send(_key(0, KEYEVENTF_UNICODE, surrogate))
                _send(_key(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, surrogate))
            time.sleep(0.012)

    @staticmethod
    def paste_text(text: str) -> bool:
        """Clipboard route -- far more reliable for CJK / long strings."""
        CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002
        if not user32.OpenClipboard(0):
            return False
        try:
            user32.EmptyClipboard()
            data = text.encode("utf-16-le") + b"\x00\x00"
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            ptr = kernel32.GlobalLock(h)
            ctypes.memmove(ptr, data, len(data))
            kernel32.GlobalUnlock(h)
            user32.SetClipboardData(CF_UNICODETEXT, h)
        finally:
            user32.CloseClipboard()
        time.sleep(0.1)
        Keyboard.hotkey("ctrl v")
        return True

    @staticmethod
    def type_text(text: str, mode: str = "auto") -> None:
        body, trailing_enter = text, False
        if body.endswith("\n"):
            body, trailing_enter = body[:-1], True
        if body:
            use_clip = mode == "clipboard" or (
                mode == "auto" and (not body.isascii() or len(body) > 60))
            if not (use_clip and Keyboard.paste_text(body)):
                Keyboard.unicode_text(body)
        if trailing_enter:
            time.sleep(0.15)
            Keyboard.hotkey("enter")


# ==============================================================================
#  Window helpers  (generic conveniences: --launch / --focus)
# ==============================================================================

def focus_window(substr: str) -> bool:
    """Bring the first visible top-level window whose title contains substr."""
    target: List[int] = []
    proto = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        b = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, b, n + 1)
        if substr.lower() in b.value.lower():
            target.append(hwnd)
            return False
        return True

    user32.EnumWindows(proto(cb), 0)
    if not target:
        return False
    h = target[0]
    if user32.IsIconic(h):
        user32.ShowWindow(h, 9)  # SW_RESTORE
    user32.SetForegroundWindow(h)
    time.sleep(0.5)
    return True


# ==============================================================================
#  UI-TARS model client
# ==============================================================================

UITARS_PROMPT = """You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format
```
Thought: ...
Action: ...
```

## Action Space

click(start_box='(x1, y1)')
left_double(start_box='(x1, y1)')
right_single(start_box='(x1, y1)')
drag(start_point='(x1, y1)', end_point='(x2, y2)')
hotkey(key='ctrl c') # Split keys with a space and use lowercase. Also, do not use more than 3 keys in one hotkey action.
type(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format. If you want to submit your input, use \\n at the end of content.
scroll(start_box='(x1, y1)', direction='down or up or right or left') # Show more information on the `direction` side.
wait() # Sleep for 5s and take a screenshot to check for any changes.
finished(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format.
call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.

## Note
- Use {language} in `Thought` part.
- Write a small plan and finally summarize your next action (with its target element) in one sentence in `Thought` part.
- Coordinates MUST be normalized to 0..1000 over the {width}x{height} screenshot.

## User Instruction
{instruction}
"""


class UITarsClient:
    def __init__(self, base_url: str, model: str = "", timeout: int = 600,
                 max_tokens: int = 512, temperature: float = 0.0) -> None:
        self.url = base_url.rstrip("/") + "/v1/chat/completions"
        self.model = model or "ui-tars"
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.temperature = temperature

    def complete(self, messages: List[Dict[str, Any]]) -> str:
        payload = json.dumps({
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "stream": False,
        }).encode()
        req = urllib.request.Request(
            self.url, data=payload,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return data["choices"][0]["message"]["content"]


# ==============================================================================
#  Action parsing
# ==============================================================================

@dataclass
class Action:
    name: str
    args: Dict[str, Any] = field(default_factory=dict)
    thought: str = ""
    raw: str = ""


# Coordinate value formats. The model may put them inside start_box, point,
# start_point or end_point. _split_kwargs strips quotes, so we need regexes
# that match the value content after the quotes are removed.
_POINT_RE = re.compile(r"<point>\s*([\d.]+)[\s,]+([\d.]+)\s*</point>")
_PAREN_BOX_RE = re.compile(r"\(\s*([\d.]+)[,\s]+([\d.]+)\s*\)")
_PAREN_BBOX_RE = re.compile(r"\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*\)")
_BBOX_RE = re.compile(r"<bbox>\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*</bbox>")
_CALL_RE = re.compile(r"^\s*([a-zA-Z_]\w*)\s*\((.*)\)\s*$", re.S)


def _split_kwargs(body: str) -> Dict[str, str]:
    """Split `a='x', b='y'` honouring quotes and escapes.

    A quoted value is preserved verbatim (no strip) so that literal newlines
    or trailing spaces the model intended -- e.g. type(content='foo\\n') --
    survive intact.  Unquoted values are stripped.
    """
    out: Dict[str, str] = {}
    key: Optional[str] = None
    buf: List[str] = []
    quote: Optional[str] = None
    quoted = False          # did the current value contain a quoted span?
    esc = False

    def flush() -> None:
        nonlocal key, buf, quoted
        val = "".join(buf)
        if not quoted:
            val = val.strip()
        if key is not None:
            out[key] = val
        elif val.strip():
            out["_"] = val
        key, buf, quoted = None, [], False

    for c in body:
        if esc:
            buf.append(c)
            esc = False
        elif c == "\\":
            buf.append(c)
            esc = True
        elif quote:
            if c == quote:
                quote = None
            else:
                buf.append(c)
        elif c in "'\"":
            quote = c
            quoted = True
        elif c == "=" and key is None:
            key = "".join(buf).strip()
            buf, quoted = [], False
        elif c == ",":
            flush()
        else:
            buf.append(c)
    if key is not None or "".join(buf).strip():
        flush()
    return out


def parse_action(text: str) -> Optional[Action]:
    thought = ""
    m = re.search(r"Thought:\s*(.+?)(?:\n\s*Action\s*:|\Z)", text, re.S | re.I)
    if m:
        thought = m.group(1).strip()

    m = re.search(r"Action\s*:\s*(.+)", text, re.S | re.I)
    body = (m.group(1) if m else text).strip()
    body = body.strip("`").strip()
    body = body.split("\n\n")[0].strip()
    # keep only the first call if the model emitted several lines
    lines = [l for l in body.splitlines() if l.strip()]
    if lines:
        cand = lines[0].strip()
        if cand.count("(") > cand.count(")") and len(lines) > 1:
            cand = " ".join(lines)
        body = cand

    cm = _CALL_RE.match(body)
    if not cm:
        return None
    name, argstr = cm.group(1).lower(), cm.group(2)

    kv = _split_kwargs(argstr)
    args: Dict[str, Any] = {}
    for k, v in kv.items():
        pts = _POINT_RE.findall(v)
        if pts:
            args[k] = (float(pts[0][0]), float(pts[0][1]))
            continue
        bb = _PAREN_BBOX_RE.findall(v) or _BBOX_RE.findall(v)
        if bb:
            x1, y1, x2, y2 = map(float, bb[0])
            args[k] = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
            continue
        sb = _PAREN_BOX_RE.findall(v)
        if sb:
            args[k] = (float(sb[0][0]), float(sb[0][1]))
            continue
        args[k] = v
    # Normalize coordinate keys: UI-TARS 1.0 uses start_box for click/scroll;
    # UI-TARS 1.5 uses point; bare arguments are stored as "_".
    if name in ("click", "left_double", "right_single", "hover"):
        for src in ("start_box", "_"):
            if src in args:
                args.setdefault("point", args.pop(src))
                break
    if name == "scroll" and "start_box" in args:
        args.setdefault("point", args.pop("start_box"))
    return Action(name=name, args=args, thought=thought, raw=text.strip())


# ==============================================================================
#  Executor  --  maps model actions onto real input
# ==============================================================================

class Executor:
    def __init__(self, screen: Screen, region: Tuple[int, int, int, int],
                 img_size: Tuple[int, int], coord_mode: str = "abs",
                 dry_run: bool = False) -> None:
        self.screen = screen
        self.region = region
        self.img_w, self.img_h = img_size
        self.coord_mode = coord_mode
        self.dry_run = dry_run
        self.mouse = Mouse(screen)

    def to_screen(self, pt: Tuple[float, float]) -> Tuple[int, int]:
        mx, my = pt
        rx, ry, rw, rh = self.region
        mode = self.coord_mode
        if mode == "auto":
            # Heuristic: normalized UI-TARS coordinates are usually 0..1000.
            mode = "norm" if (mx > 50 or my > 50) else "abs"
        if mode == "norm":
            fx, fy = mx / 1000.0, my / 1000.0
        else:  # absolute pixels within the image we sent
            fx = mx / max(self.img_w - 1, 1)
            fy = my / max(self.img_h - 1, 1)
        return (int(round(rx + fx * (rw - 1))), int(round(ry + fy * (rh - 1))))

    def run(self, a: Action) -> str:
        n, g = a.name, a.args

        def pt(key="point"):
            v = g.get(key)
            if not isinstance(v, tuple):
                raise ValueError(f"missing coordinate for {n}")
            return self.to_screen(v)

        if n in ("click", "left_single", "hover"):
            x, y = pt()
            self._log(f"click @ ({x},{y})")
            if not self.dry_run:
                (self.mouse.move if n == "hover" else self.mouse.click)(x, y)
            return f"click({x},{y})"

        if n in ("left_double", "double_click"):
            x, y = pt()
            self._log(f"double-click @ ({x},{y})")
            if not self.dry_run:
                self.mouse.click(x, y, double=True)
            return f"left_double({x},{y})"

        if n in ("right_single", "right_click"):
            x, y = pt()
            self._log(f"right-click @ ({x},{y})")
            if not self.dry_run:
                self.mouse.click(x, y, button="right")
            return f"right_single({x},{y})"

        if n == "drag":
            x1, y1 = pt("start_point")
            x2, y2 = pt("end_point")
            self._log(f"drag ({x1},{y1}) -> ({x2},{y2})")
            if not self.dry_run:
                self.mouse.drag(x1, y1, x2, y2)
            return f"drag({x1},{y1}->{x2},{y2})"

        if n == "scroll":
            direction = str(g.get("direction", "down")).strip("'\" ")
            try:
                x, y = pt()
            except ValueError:
                x = self.region[0] + self.region[2] // 2
                y = self.region[1] + self.region[3] // 2
            self._log(f"scroll {direction} @ ({x},{y})")
            if not self.dry_run:
                self.mouse.scroll(x, y, direction)
            return f"scroll({direction})"

        if n == "hotkey":
            combo = str(g.get("key") or g.get("_") or "").strip("'\" ")
            self._log(f"hotkey {combo!r}")
            if not self.dry_run:
                Keyboard.hotkey(combo)
            return f"hotkey({combo})"

        if n == "type":
            raw = str(g.get("content") or g.get("_") or "")
            content = raw.replace("\\n", "\n").replace("\\'", "'").replace('\\"', '"')
            self._log(f"type {content!r}")
            if not self.dry_run:
                Keyboard.type_text(content)
            return f"type({content[:40]})"

        if n == "wait":
            self._log("wait 5s")
            time.sleep(5)
            return "wait()"

        if n in ("finished", "call_user"):
            return n + "()"

        raise ValueError(f"unsupported action: {n}")

    @staticmethod
    def _log(msg: str) -> None:
        print(f"      -> {msg}", flush=True)


# ==============================================================================
#  Agent loop
# ==============================================================================

def encode_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return base64.b64encode(buf.getvalue()).decode()


def fit(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_side:
        return img
    scale = max_side / max(w, h)
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                      Image.LANCZOS)


class GuiAgent:
    def __init__(self, task: str, client: UITarsClient, *,
                 region: Optional[Tuple[int, int, int, int]] = None,
                 max_steps: int = 25, max_side: int = 1120,
                 history_images: int = 1, coord_mode: str = "abs",
                 language: str = "Chinese", dry_run: bool = False,
                 hint: str = "", run_dir: Optional[str] = None) -> None:
        self.task = task
        self.client = client
        self.screen = Screen()
        self.region = region or (self.screen.x, self.screen.y,
                                 self.screen.w, self.screen.h)
        self.max_steps = max_steps
        self.max_side = max_side
        self.history_images = max(0, history_images)
        self.coord_mode = coord_mode
        self.language = language
        self.dry_run = dry_run
        self.hint = hint
        self.run_dir = run_dir
        if run_dir:
            os.makedirs(run_dir, exist_ok=True)
        self.history: List[Dict[str, str]] = []   # {"thought","action"}
        self.shots: List[str] = []                # recent base64 images

    def _messages(self, b64: str, iw: int, ih: int) -> List[Dict[str, Any]]:
        sys_txt = UITARS_PROMPT.format(language=self.language,
                                       instruction=self.task,
                                       width=iw, height=ih)
        if self.hint:
            sys_txt += f"\n## Extra Context\n{self.hint}\n"
        sys_txt += ("\n## Coordinate Instructions\n"
                    "Use normalized coordinates in range 0..1000 for any "
                    "click/double/scroll/drag action. Example: "
                    "click(start_box='(400,500)').\n")

        content: List[Dict[str, Any]] = []
        if self.history:
            lines = []
            for i, h in enumerate(self.history[-8:], 1):
                lines.append(f"Step {i}: {h['action']}")
            content.append({"type": "text",
                            "text": "Previous actions you already performed:\n"
                                    + "\n".join(lines)})
        for old in self.shots[-self.history_images:] if self.history_images else []:
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{old}"}})
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}})
        content.append({"type": "text", "text": "What is the next action?"})

        return [{"role": "system", "content": sys_txt},
                {"role": "user", "content": content}]

    def run(self) -> Tuple[bool, str]:
        print("=" * 78)
        print(f"TASK      : {self.task}")
        print(f"REGION    : {self.region}   coord-mode={self.coord_mode}")
        print(f"MODEL     : {self.client.url}")
        print(f"DRY RUN   : {self.dry_run}")
        print("=" * 78, flush=True)

        for step in range(1, self.max_steps + 1):
            img_full = self.screen.capture(self.region)
            img = fit(img_full, self.max_side)
            iw, ih = img.size
            b64 = encode_png(img)

            if self.run_dir:
                img.save(os.path.join(self.run_dir, f"step{step:02d}.png"))

            print(f"\n[STEP {step}/{self.max_steps}] image={iw}x{ih} "
                  f"inferring...", flush=True)
            t0 = time.time()
            try:
                out = self.client.complete(self._messages(b64, iw, ih))
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                print(f"      !! model error: {e}", flush=True)
                time.sleep(3)
                continue
            dt = time.time() - t0

            act = parse_action(out)
            print(f"      ({dt:.1f}s) {out.strip()[:500]}", flush=True)
            if act is None:
                print("      !! unparseable action, retrying", flush=True)
                self.history.append({"thought": "", "action": "(unparseable)"})
                continue

            executor = Executor(self.screen, self.region, (iw, ih),
                                self.coord_mode, self.dry_run)

            if act.name == "finished":
                msg = str(act.args.get("content") or act.args.get("_") or "done")
                print(f"\n*** FINISHED: {msg}", flush=True)
                return True, msg
            if act.name == "call_user":
                print("\n*** MODEL ASKED FOR HUMAN HELP", flush=True)
                return False, "call_user"

            try:
                done = executor.run(act)
            except Exception as e:
                print(f"      !! exec error: {e}", flush=True)
                self.history.append({"thought": act.thought,
                                     "action": f"{act.name} FAILED: {e}"})
                continue

            self.history.append({"thought": act.thought, "action": done})
            self.shots.append(b64)
            self.shots = self.shots[-4:]
            time.sleep(0.8)

        print("\n*** MAX STEPS REACHED", flush=True)
        return False, "max_steps"


# ==============================================================================
#  CLI
# ==============================================================================

def main() -> int:
    p = argparse.ArgumentParser(
        description="Universal GUI agent driven by ByteDance UI-TARS-1.5")
    p.add_argument("task_pos", nargs="?", help="task description")
    p.add_argument("--task", help="task description")
    p.add_argument("--server", default="http://127.0.0.1:8080")
    p.add_argument("--model", default="")
    p.add_argument("--max-steps", type=int, default=25)
    p.add_argument("--max-side", type=int, default=1120,
                   help="longest edge of the image sent to the model")
    p.add_argument("--history-images", type=int, default=1)
    p.add_argument("--coord-mode", choices=["abs", "norm", "auto"], default="auto")
    p.add_argument("--language", default="Chinese")
    p.add_argument("--region", help="x,y,w,h  restrict to a screen area")
    p.add_argument("--launch", help="program to start before the task")
    p.add_argument("--focus", help="focus a window whose title contains this")
    p.add_argument("--clear", action="store_true",
                   help="minimize all visible top-level windows before starting")
    p.add_argument("--hint", default="", help="extra context for the model")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--run-dir", help="save per-step screenshots here")
    p.add_argument("--timeout", type=int, default=600)
    a = p.parse_args()

    task = a.task or a.task_pos
    if not task:
        p.error("a task description is required")

    if a.clear:
        subprocess.run([sys.executable,
                        os.path.join(os.path.dirname(__file__), "clear_desktop.py")],
                       check=False)
        time.sleep(1)
    if a.launch:
        os.startfile(a.launch)  # noqa: S606 - user supplied
        time.sleep(3)
    if a.focus:
        print(f"focus window ~ {a.focus!r}: {focus_window(a.focus)}", flush=True)

    region = None
    if a.region:
        region = tuple(int(v) for v in a.region.split(","))  # type: ignore

    agent = GuiAgent(
        task, UITarsClient(a.server, a.model, timeout=a.timeout),
        region=region, max_steps=a.max_steps, max_side=a.max_side,
        history_images=a.history_images, coord_mode=a.coord_mode,
        language=a.language, dry_run=a.dry_run, hint=a.hint,
        run_dir=a.run_dir)
    ok, _ = agent.run()
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True, errors="replace")
    except Exception:
        pass
    sys.exit(main())
