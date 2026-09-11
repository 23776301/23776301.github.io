#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Logged GUI agent -- wraps gui_agent.py and records EVERY step so a human can
audit the whole run:

    for each step:
        1. capture a BEFORE screenshot (just before the action)
        2. ask the vision model what to do next
        3. parse + execute the action (real SendInput mouse/keyboard)
        4. capture an AFTER screenshot (just after the action)
        5. ask the model to describe what changed in the UI

Outputs into --run-dir:
    steps.md       human-readable narrative (action, coords, change, image links)
    steps.html     gallery: before -> after image pairs with change captions
    steps.jsonl    machine-readable per-step records
    stepNN_before.png / stepNN_after.png

This is the "screenshot -> analyze -> click -> screenshot -> analyze" loop made
fully observable. No application-specific logic is hardcoded -- pass task/hint
on the command line. An optional --detect-windows injects a neutral list of the
currently visible top-level windows as extra context for the model.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gui_agent import (UITARS_PROMPT, UITarsClient, parse_action, Screen,
                       Executor, fit, encode_png)


# ------------------------------------------------------------------------------
#  Optional neutral window detection (no app-specific names hardcoded)
# ------------------------------------------------------------------------------
def detect_windows() -> str:
    """Return a short, app-agnostic list of visible top-level windows so the
    model knows what is on screen. Excludes shell/explorer chrome."""
    user32 = ctypes.windll.user32
    out: list[str] = []

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
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        if title:
            out.append(f"{title} [{cls.value}] rect=({r.left},{r.top},{r.right},{r.bottom})")
        return True

    user32.EnumWindows(cb, 0)
    return "; ".join(out[:30]) if out else "(none)"


# ------------------------------------------------------------------------------
#  Prompt builders
# ------------------------------------------------------------------------------
def build_messages(task, hint, b64, iw, ih, history, shots,
                   history_images=1, language="Chinese"):
    sys_txt = UITARS_PROMPT.format(language=language, instruction=task,
                                   width=iw, height=ih)
    if hint:
        sys_txt += f"\n## Extra Context\n{hint}\n"
    sys_txt += (
        "\n## Coordinate Instructions\n"
        "Use normalized coordinates in range 0..1000 for any "
        "click/double/scroll/drag action. Example: "
        "click(start_box='(400,500)').\n")
    content = []
    if history:
        lines = [f"Step {i}: {h['action']}" for i, h in enumerate(history[-8:], 1)]
        content.append({"type": "text",
                        "text": "Previous actions you already performed:\n"
                                + "\n".join(lines)})
    for old in (shots[-history_images:] if history_images else []):
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{old}"}})
    content.append({"type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64}"}})
    content.append({"type": "text", "text": "What is the next action?"})
    return [{"role": "system", "content": sys_txt},
            {"role": "user", "content": content}]


def caption_change(client, before_b64, after_b64):
    sys_txt = ("你是GUI观察员。请简要用中文说明两张截图之间界面发生了什么变化，"
               "聚焦：新出现的窗口/菜单/对话框、被选中或勾选的项、文本内容变化、"
               "以及鼠标点击位置附近的变化。要具体、简洁（不超过60字）。")
    content = [
        {"type": "image_url",
         "image_url": {"url": f"data:image/png;base64,{before_b64}"}},
        {"type": "image_url",
         "image_url": {"url": f"data:image/png;base64,{after_b64}"}},
        {"type": "text", "text": "第一张是操作前，第二张是操作后。请简要说明界面发生了什么变化。"},
    ]
    try:
        return client.complete([{"role": "system", "content": sys_txt},
                                {"role": "user", "content": content}]).strip()
    except Exception as e:  # noqa: BLE001
        return f"(变化描述失败: {e})"


# ------------------------------------------------------------------------------
#  Main loop
# ------------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--task", required=True)
    p.add_argument("--server", default="http://127.0.0.1:8080")
    p.add_argument("--max-steps", type=int, default=14)
    p.add_argument("--max-side", type=int, default=1120)
    p.add_argument("--history-images", type=int, default=1)
    p.add_argument("--language", default="Chinese")
    p.add_argument("--region")
    p.add_argument("--hint", default="")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--clear", action="store_true")
    p.add_argument("--detect-windows", action="store_true",
                   help="inject a neutral list of visible windows as context")
    p.add_argument("--timeout", type=int, default=600)
    a = p.parse_args()

    os.makedirs(a.run_dir, exist_ok=True)
    if a.clear:
        subprocess.run([sys.executable,
                        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "clear_desktop.py")], check=False)
        time.sleep(1)

    hint = a.hint
    if a.detect_windows:
        hint += f"\n\n[窗口探测] 当前可见顶层窗口：{detect_windows()}。"

    client = UITarsClient(a.server, timeout=a.timeout, max_tokens=512)
    cap_client = UITarsClient(a.server, timeout=a.timeout, max_tokens=300)
    screen = Screen()
    region = (tuple(int(v) for v in a.region.split(","))
              if a.region else (screen.x, screen.y, screen.w, screen.h))

    history = []
    shots = []
    records = []
    steps_md = ["# GUI Agent 逐步执行记录\n",
                f"- 任务: {a.task}\n",
                f"- 区域: {region}\n",
                f"- 模型: {a.server}\n", ""]

    for step in range(1, a.max_steps + 1):
        before = screen.capture(region)
        before_fit = fit(before, a.max_side)
        iw, ih = before_fit.size
        before_b64 = encode_png(before_fit)
        before_path = os.path.join(a.run_dir, f"step{step:02d}_before.png")
        before_fit.save(before_path)

        msgs = build_messages(a.task, hint, before_b64, iw, ih, history, shots,
                              a.history_images, a.language)
        try:
            out = client.complete(msgs)
        except Exception as e:  # noqa: BLE001
            steps_md.append(f"\n## Step {step}: 模型错误 {e}\n")
            time.sleep(3)
            continue

        act = parse_action(out)
        if act is None:
            steps_md.append(f"\n## Step {step}: 无法解析动作，重试\n原始输出: {out[:300]}\n")
            history.append({"action": "(unparseable)"})
            continue

        coord_txt = ""
        if "point" in act.args:
            pt = act.args["point"]
            coord_txt = f"（归一化0-1000 = {pt[0]:.0f},{pt[1]:.0f}）"

        if act.name == "finished":
            steps_md.append(f"\n## Step {step}: FINISHED\n动作: {out.strip()[:400]}\n")
            records.append({"step": step, "action": "finished", "raw": out})
            break
        if act.name == "call_user":
            steps_md.append(f"\n## Step {step}: 模型请求人工帮助\n{out.strip()[:300]}\n")
            break

        try:
            done = Executor(screen, region, (iw, ih), "auto", False).run(act)
        except Exception as e:  # noqa: BLE001
            steps_md.append(f"\n## Step {step}: 执行出错 {e}\n动作: {out.strip()[:300]}\n")
            history.append({"action": f"{act.name} FAILED: {e}"})
            continue

        history.append({"action": done})
        shots.append(before_b64)
        shots = shots[-4:]
        time.sleep(1.0)

        after = screen.capture(region)
        after_fit = fit(after, a.max_side)
        after_b64 = encode_png(after_fit)
        after_path = os.path.join(a.run_dir, f"step{step:02d}_after.png")
        after_fit.save(after_path)

        cap = caption_change(cap_client, before_b64, after_b64)

        rec = {"step": step, "action": act.name, "args": act.args,
               "thought": act.thought, "raw": out,
               "before": os.path.basename(before_path),
               "after": os.path.basename(after_path), "change": cap}
        records.append(rec)
        steps_md.append(
            f"\n## Step {step}: {act.name} {coord_txt}\n"
            f"- 原始输出: `{out.strip()[:400]}`\n"
            f"- 执行结果: {done}\n"
            f"- 界面变化: {cap}\n"
            f"- 截图: [操作前]({os.path.basename(before_path)}) -> "
            f"[操作后]({os.path.basename(after_path)})\n")
        with open(os.path.join(a.run_dir, "steps.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[STEP {step}] {act.name} | {cap[:60]}", flush=True)

    with open(os.path.join(a.run_dir, "steps.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(steps_md))
    _write_html(a.run_dir, a.task, records)
    print("DONE. run_dir=", a.run_dir, flush=True)


def _write_html(run_dir, task, records):
    rows = []
    for r in records:
        if r.get("action") == "finished":
            rows.append(f"<h3>完成: {r.get('raw','')[:200]}</h3>")
            continue
        before = r.get("before", "")
        after = r.get("after", "")
        rows.append(
            f"<div class='step'><h3>Step {r['step']}: {r['action']}</h3>"
            f"<p class='raw'>{r.get('raw','').strip()[:400]}</p>"
            f"<div class='imgs'><img src='{before}'/>"
            f"<span class='arrow'>&rarr;</span><img src='{after}'/></div>"
            f"<p class='change'>变化: {r.get('change','')}</p></div>")
    html = f"""<!doctype html><html lang='zh'><head><meta charset='utf-8'>
<style>
body{{font-family:system-ui,'Microsoft YaHei',sans-serif;margin:20px;background:#fafafa}}
h1{{color:#222}}.step{{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}}
.raw{{font-family:monospace;background:#f4f4f4;padding:6px;border-radius:4px;white-space:pre-wrap;font-size:12px}}
.imgs{{display:flex;gap:8px;align-items:center;flex-wrap:wrap}}
.imgs img{{max-width:48%;border:1px solid #ccc;border-radius:4px}}
.arrow{{font-size:24px;color:#c33}}.change{{color:#0a6;font-weight:600}}
</style></head><body><h1>GUI Agent 逐步执行记录</h1><p>任务: {task}</p>
{''.join(rows)}</body></html>"""
    with open(os.path.join(run_dir, "steps.html"), "w", encoding="utf-8") as f:
        f.write(html)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True, errors="replace")
    except Exception:
        pass
    main()
