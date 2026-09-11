#!/usr/bin/env python3
"""
opencode_audit.py — 将 opencode.db 中的会话解析并格式化为人类可读的审计档案。

核心产物：Material 风格(mkdocs-material) 的交互式 HTML 树。
采用「渐进式披露」：默认只展示会话/回合的摘要概括，
思考过程、工具调用、命令输出等细节全部折叠到更深层级，用户展开才显示。

用法:
  python3 opencode_audit.py [--db PATH] [--out DIR] [--session ID] [--format html|md|both]

说明:
  - 默认读取 ~/.local/share/opencode/opencode.db
  - 默认输出到 ~/opencode-audit/，每会话一个 .html（并可选 .md），另生成 index.html 索引
  - --session 传会话 ID 则只导出该会话；不传则导出全部
  - --format 控制输出 html / md / both（默认 both）
"""

import sqlite3, json, os, sys, argparse, html, re
from datetime import datetime

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
DEFAULT_OUT = os.path.expanduser("~/opencode-audit")

# 工具 -> 人类可读标签
TOOL_LABEL = {
    "bash": "命令执行", "read": "读取文件", "write": "写入文件",
    "edit": "编辑文件", "delete": "删除文件", "grep": "搜索内容",
    "glob": "查找文件", "list": "列出目录", "webfetch": "抓取网页",
    "websearch": "网页搜索", "todo": "任务清单", "patch": "应用补丁",
    "notify": "发送通知", "browser": "浏览器操作", "mcp": "MCP 调用",
}
DEFAULT_LABEL = "工具调用"


def ts_to_str(ts_ms):
    if not ts_ms:
        return "N/A"
    try:
        return datetime.fromtimestamp(ts_ms / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "N/A"


def esc(s):
    return html.escape(str(s))


def connect(db_path):
    if not os.path.exists(db_path):
        sys.exit(f"错误：找不到数据库 {db_path}")
    return sqlite3.connect(db_path)


def load_sessions(conn, session_id=None):
    cur = conn.cursor()
    if session_id:
        cur.execute("SELECT * FROM session WHERE id=?", (session_id,))
    else:
        cur.execute("SELECT * FROM session ORDER BY time_created ASC")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def load_messages(conn, session_id):
    cur = conn.cursor()
    cur.execute("SELECT id, session_id, time_created, data FROM message "
                "WHERE session_id=? ORDER BY time_created ASC", (session_id,))
    msgs = []
    for mid, sid, ts, data in cur.fetchall():
        try:
            d = json.loads(data)
        except Exception:
            d = {}
        msgs.append({"id": mid, "time_created": ts, "data": d})
    return msgs


def load_parts(conn, message_id):
    cur = conn.cursor()
    cur.execute("SELECT id, message_id, time_created, data FROM part "
                "WHERE message_id=? ORDER BY time_created ASC", (message_id,))
    parts = []
    for pid, mid, ts, data in cur.fetchall():
        try:
            d = json.loads(data)
        except Exception:
            d = {}
        parts.append({"id": pid, "time_created": ts, "data": d})
    return parts


def tool_input_text(part_data):
    """把 tool 的 input 整理成可读文本"""
    state = part_data.get("state") or {}
    inp = state.get("input") or {}
    tool = part_data.get("tool", "")
    lines = []
    if tool == "bash" and "command" in inp:
        lines.append("$ " + str(inp["command"]))
    if "filePath" in inp:
        lines.append(f"文件: {inp['filePath']}")
    for k, v in inp.items():
        if k in ("command", "filePath"):
            continue
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        lines.append(f"{k}: {v}")
    return "\n".join(lines)


def tool_summary(part_data):
    """工具的一句话摘要（用于折叠标题）"""
    tool = part_data.get("tool", "")
    state = part_data.get("state") or {}
    inp = state.get("input") or {}
    if tool == "bash":
        cmd = str(inp.get("command", "")).strip().split("\n")[0]
        return "$ " + cmd[:90]
    fp = inp.get("filePath", "")
    if tool == "write":
        return f"写入文件 {fp}（{len(str(inp.get('content','')))} 字符）"
    if tool == "edit":
        return f"编辑文件 {fp}"
    if tool == "delete":
        return f"删除文件 {fp}"
    if tool == "read":
        return f"读取文件 {fp}"
    if tool == "grep":
        return f"搜索 {inp.get('pattern','')}"
    if tool == "glob":
        return f"查找 {inp.get('pattern','')}"
    if tool == "webfetch":
        return f"抓取 {inp.get('url','')}"
    if tool == "websearch":
        return f"网页搜索 {inp.get('query','')}"
    if fp:
        return f"{tool} {fp}"
    if inp:
        first = next(iter(inp.values()))
        return f"{tool}: {str(first)[:80]}"
    return tool


def snippet(text, n=160):
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[:n].rstrip() + "…"


# ---------------------------------------------------------------------------
# Markdown（可选保留，默认不推荐：一次性铺开全部内容）
# ---------------------------------------------------------------------------
def render_markdown(sess, msgs, conn):
    lines = [f"# 会话审计: {sess['title'] or '(无标题)'}", "",
             f"- 会话 ID: `{sess['id']}`",
             f"- 创建时间: {ts_to_str(sess.get('time_created'))}",
             f"- 最后更新: {ts_to_str(sess.get('time_updated'))}",
             f"- 模型: {sess.get('model') or 'N/A'}",
             f"- 成本: ${sess.get('cost') or 0:.6f}", ""]
    # 按 user 消息切分回合
    rounds = split_rounds(msgs)
    for i, (u, assists) in enumerate(rounds, 1):
        lines.append(f"## 回合 {i}")
        for p in load_parts(conn, u["id"]):
            if p["data"].get("type") == "text":
                lines += ["", "**用户**", "", "> " + (p["data"].get("text") or "")]
        for m in assists:
            lines.append("")
            for p in load_parts(conn, m["id"]):
                pt = p["data"].get("type")
                if pt == "reasoning":
                    lines += ["**思考过程**", "", "```", (p["data"].get("text") or ""), "```"]
                elif pt == "tool":
                    t = p["data"].get("tool", "")
                    lines += [f"**{TOOL_LABEL.get(t, DEFAULT_LABEL)} `{t}`**", ""]
                    it = tool_input_text(p["data"])
                    if it:
                        lines += ["```", it, "```"]
                    out = (p["data"].get("state") or {}).get("output")
                    if out:
                        lines += ["输出：", "```", str(out), "```"]
                elif pt == "text":
                    lines += ["**回复**", "", (p["data"].get("text") or ""), ""]
        lines.append("")
    return "\n".join(lines)


def split_rounds(msgs):
    """把消息切成 [ (user_msg, [assistant_msgs...]), ... ] 回合"""
    rounds = []
    cur_user = None
    cur_assists = []
    for m in msgs:
        role = m["data"].get("role")
        if role == "user":
            if cur_user is not None:
                rounds.append((cur_user, cur_assists))
            cur_user = m
            cur_assists = []
        elif role == "assistant" and cur_user is not None:
            cur_assists.append(m)
    if cur_user is not None:
        rounds.append((cur_user, cur_assists))
    return rounds


# ---------------------------------------------------------------------------
# Material 风格交互式 HTML
# ---------------------------------------------------------------------------
MATERIAL_CSS = """
:root{
  --md-primary:#4051b5; --md-primary-2:#526cfe; --md-accent:#ff6e42;
  --bg:#f5f6fa; --surface:#ffffff; --surface-2:#f8f9fc;
  --text:#1c1e21; --text-2:#5f6368; --text-3:#9aa0a6;
  --border:#e4e6ee; --border-2:#eef0f6;
  --shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.06);
  --shadow-2:0 4px 12px rgba(0,0,0,.10);
  --radius:12px; --radius-sm:8px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:"Roboto","Helvetica Neue","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 80px}
/* ---------- header ---------- */
header.card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);
  padding:22px 26px;margin-bottom:22px}
header.card h1{margin:0 0 4px;font-size:24px;font-weight:600;letter-spacing:.2px}
.breadcrumb{font-size:13px;color:var(--text-3);margin-bottom:10px}
.breadcrumb a{color:var(--md-primary-2);text-decoration:none}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{background:var(--surface-2);border:1px solid var(--border);border-radius:999px;
  padding:3px 12px;font-size:12.5px;color:var(--text-2)}
.chip b{color:var(--text);font-weight:600}
.code{font-family:"Roboto Mono","Cascadia Code",Consolas,monospace;font-size:12px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:1px 6px}
/* ---------- toolbar ---------- */
.toolbar{display:flex;gap:10px;align-items:center;margin:16px 0}
.toolbar .spacer{flex:1}
button.md{font-family:inherit;font-size:13px;font-weight:500;border:none;cursor:pointer;
  padding:8px 16px;border-radius:999px;transition:.15s;letter-spacing:.2px}
button.md.filled{background:var(--md-primary-2);color:#fff;box-shadow:var(--shadow)}
button.md.filled:hover{background:var(--md-primary);box-shadow:var(--shadow-2)}
button.md.tonal{background:#e6e9ff;color:var(--md-primary)}
button.md.tonal:hover{background:#d9deff}
.counter{font-size:13px;color:var(--text-3)}
/* ---------- round tree ---------- */
.tree{display:flex;flex-direction:column;gap:14px}
details.round{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);
  border:1px solid var(--border);overflow:hidden;transition:box-shadow .15s}
details.round[open]{box-shadow:var(--shadow-2)}
details.round>summary{list-style:none;cursor:pointer;padding:14px 18px;
  display:flex;gap:14px;align-items:flex-start;user-select:none}
details.round>summary::-webkit-details-marker{display:none}
details.round>summary:hover{background:var(--surface-2)}
.chev{flex:none;width:20px;height:20px;margin-top:2px;transition:transform .2s;color:var(--text-3)}
details[open]>summary .chev{transform:rotate(90deg)}
.chev svg{width:20px;height:20px;display:block}
.round-head{flex:1;min-width:0}
.round-q{font-size:14.5px;color:var(--text);margin-bottom:6px}
.round-q .u{color:var(--md-primary-2);font-weight:600;margin-right:6px}
.round-a{font-size:13.5px;color:var(--text-2)}
.round-meta{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.stat{font-size:11.5px;background:#eef1ff;color:var(--md-primary);border-radius:999px;padding:1px 10px}
/* round body */
.round-body{padding:6px 18px 16px;border-top:1px solid var(--border-2)}
.user-full{background:#f0f4ff;border-left:3px solid var(--md-primary-2);
  border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:12px 16px;margin:14px 0;
  white-space:pre-wrap;font-size:14px}
.assist-label{font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:.6px;
  margin:16px 0 8px;display:flex;align-items:center;gap:8px}
.assist-label::after{content:"";flex:1;height:1px;background:var(--border)}
/* leaf details */
details.block{background:var(--surface-2);border:1px solid var(--border);
  border-radius:var(--radius-sm);margin:8px 0;overflow:hidden}
details.block>summary{list-style:none;cursor:pointer;padding:9px 14px;font-size:13.5px;
  display:flex;align-items:center;gap:8px;color:var(--text-2);user-select:none}
details.block>summary::-webkit-details-marker{display:none}
details.block>summary:hover{background:#eef0f8}
details.block[open]>summary{border-bottom:1px solid var(--border)}
details.reasoning>summary{color:#6b7280;font-style:italic}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
.block-body{padding:12px 14px}
.block-body pre{font-family:"Roboto Mono","Cascadia Code",Consolas,monospace;font-size:12.5px;color:#3b3f45}
.tool-icon{flex:none}
.tool-name{font-weight:600;color:var(--md-primary)}
.tool-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:"Roboto Mono","Cascadia Code",Consolas,monospace;font-size:12.5px;color:var(--text-2)}
.tool-status{flex:none;font-size:11px;padding:1px 9px;border-radius:999px;font-weight:500}
.tool-status.ok{background:#e6f6ee;color:#1e8e4e}
.tool-status.err{background:#fde8ec;color:#c62839}
.tool-status.run{background:#fff3e0;color:#b26a00}
.lab{font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px}
.lab:first-child{margin-top:0}
.lab b{color:var(--text-2);text-transform:none;letter-spacing:0;font-size:12px}
.out-long summary{color:var(--md-primary-2);font-size:12.5px;cursor:pointer}
.stepfin{color:var(--text-3);font-size:12px;font-style:italic;margin:6px 0;text-align:center}
.reply{white-space:pre-wrap;font-size:14px;color:var(--text)}
details.reply-block>summary{white-space:pre-wrap}
/* tool body: command -> output nesting */
.tool-body{padding:12px 14px}
.tool-body .lab{margin:0 0 4px}
.tool-body pre.cmd{font-family:"Roboto Mono","Cascadia Code",Consolas,monospace;font-size:12.5px;
  background:#0b0e13;color:#7ec8ff;border:1px solid #1e2530;border-radius:6px;padding:9px 11px;white-space:pre-wrap}
/* nested output block */
details.out{margin:10px 0 0;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:#0f1115}
details.out>summary{list-style:none;cursor:pointer;padding:7px 12px;font-size:12.5px;color:#9db3d0;
  background:#131823;display:flex;align-items:center;gap:6px;user-select:none}
details.out>summary::-webkit-details-marker{display:none}
details.out>summary:hover{background:#182031}
details.out[open]>summary{border-bottom:1px solid var(--border)}
.out-body{padding:10px 12px;background:#0f1115}
details.out-long>summary{list-style:none;cursor:pointer;color:#7ec8ff;font-size:12.5px;user-select:none}
details.out-long>summary::-webkit-details-marker{display:none}
pre.lead{font-size:11.5px;color:#5f6b7a;font-family:"Roboto Mono",Consolas,monospace;white-space:pre-wrap;margin-bottom:8px}
/* JSON tree */
.jbody{margin-left:14px;border-left:1px solid #26303e;padding-left:10px}
details.jnode>summary{list-style:none;cursor:pointer;font-size:12.5px;padding:2px 0;color:#c9d6e8;user-select:none}
details.jnode>summary::-webkit-details-marker{display:none}
details.jnode>summary:hover{color:#7ec8ff}
details.jnode[open]>summary{color:#7ec8ff}
.jk{color:#8aa0b8}
.jv{color:#a8e08c;font-family:"Roboto Mono",Consolas,monospace}
.jleaf{font-size:12.5px;padding:1px 0;color:#d7dee9}
footer{text-align:center;color:var(--text-3);font-size:12.5px;margin-top:40px}
"""


def detect_json(text):
    """尝试从文本中识别 JSON（兼容 curl 进度条前置内容）"""
    s = text.strip()
    for ch in ("{", "["):
        idx = s.find(ch)
        if idx != -1:
            try:
                obj = json.loads(s[idx:])
                return obj, s[:idx]
            except Exception:
                continue
    return None, None


def json_tree(node, key=None, depth=0, is_root=False):
    """把 JSON 渲染成可逐层展开的树（details 嵌套）"""
    if isinstance(node, dict):
        label = ((str(key) + ": ") if key is not None else "") + "{" + str(len(node)) + " 字段}"
        inner = "".join(json_tree(v, k, depth + 1) for k, v in node.items())
        open_attr = " open" if (is_root or depth == 0) else ""
        return (f'<details class="jnode"{open_attr}><summary><span class="jk">{esc(label)}</span></summary>'
                f'<div class="jbody">{inner}</div></details>')
    if isinstance(node, list):
        label = ((str(key) + ": ") if key is not None else "") + "[" + str(len(node)) + " 项]"
        inner = "".join(json_tree(v, f"[{i}]", depth + 1) for i, v in enumerate(node))
        return (f'<details class="jnode"><summary><span class="jk">{esc(label)}</span></summary>'
                f'<div class="jbody">{inner}</div></details>')
    val = node if isinstance(node, str) else json.dumps(node, ensure_ascii=False)
    keytxt = f'<span class="jk">{esc(str(key))}</span>: ' if key is not None else ""
    return f'<div class="jleaf">{keytxt}<span class="jv">{esc(val)}</span></div>'


def output_html(raw):
    """命令/工具输出：默认折叠在命令之下；结构化 JSON 渲染为可展开树"""
    text = str(raw)
    n = len(text)
    obj, leading = detect_json(text)
    if obj is not None:
        summ = f"JSON 对象 · {len(obj)} 个字段" if isinstance(obj, dict) else f"JSON 数组 · {len(obj)} 项"
        body = []
        if leading.strip():
            body.append(f'<pre class="lead">{esc(leading)}</pre>')
        body.append(json_tree(obj, is_root=True))
        return (f'<details class="out"><summary>📦 {esc(summ)} · {n} 字符</summary>'
                f'<div class="out-body">{"".join(body)}</div></details>')
    first = snippet(re.sub(r"\s+", " ", text), 80)
    body = f"<pre>{esc(text)}</pre>"
    if n > 1200:
        body = (f'<details class="out-long"><summary>{esc(first)}…（{n} 字符）</summary>'
                f"<pre>{esc(text)}</pre></details>")
    return (f'<details class="out"><summary>📦 输出 · {n} 字符</summary>'
            f'<div class="out-body">{body}</div></details>')


def tool_html(pdata):
    tool = pdata.get("tool", "")
    label = TOOL_LABEL.get(tool, DEFAULT_LABEL)
    state = pdata.get("state") or {}
    status = state.get("status", "N/A")
    status_cls = "ok" if status == "completed" else ("err" if status == "error" else "run")
    sum_ = tool_summary(pdata)
    inp_txt = tool_input_text(pdata)
    out = state.get("output")
    h = ['<details class="block tool">',
         f'<summary><span class="tool-icon">🔧</span>'
         f'<span class="tool-name">{esc(label)}</span>'
         f'<span class="tool-sum">{esc(sum_)}</span>'
         f'<span class="tool-status {status_cls}">{esc(status)}</span></summary>',
         '<div class="tool-body">']
    if inp_txt:
        h.append('<div class="lab">命令 / 输入</div>')
        h.append(f'<pre class="cmd">{esc(inp_txt)}</pre>')
    if out:
        h.append(output_html(out))
    h.append('</div></details>')
    return "\n".join(h)


def reasoning_html(pdata):
    return ('<details class="block reasoning" open>'
            '<summary><span class="tool-icon">💭</span><span>思考过程</span></summary>'
            f'<div class="block-body"><pre>{esc(pdata.get("text") or "")}</pre></div></details>')


def reply_html(pdata):
    text = pdata.get("text") or ""
    if len(text) > 400:
        return (f'<details class="block reply-block"><summary>📄 助手回复（{len(text)} 字符）<br>'
                f'<span style="color:var(--text-3);font-size:12.5px">{esc(snippet(text,120))}</span></summary>'
                f'<div class="block-body"><div class="reply">{esc(text)}</div></div></details>')
    return f'<div class="reply">{esc(text)}</div>'


def round_html(conn, idx, user_msg, assistant_msgs):
    # 用户提示
    u_text = ""
    for p in load_parts(conn, user_msg["id"]):
        if p["data"].get("type") == "text":
            u_text = p["data"].get("text", "")
            break
    # 统计
    n_steps = 0
    n_tools = 0
    n_reason = 0
    reply_snippet = ""
    body = []
    first_reply = None
    for m in assistant_msgs:
        for p in load_parts(conn, m["id"]):
            pt = p["data"].get("type")
            if pt == "step-finish":
                n_steps += 1
                body.append('<div class="stepfin">— 本步结束 —</div>')
            elif pt == "reasoning":
                n_reason += 1
                body.append(reasoning_html(p["data"]))
            elif pt == "tool":
                n_tools += 1
                body.append(tool_html(p["data"]))
            elif pt == "text":
                txt = p["data"].get("text", "")
                if first_reply is None:
                    first_reply = txt
                body.append(reply_html(p["data"]))
    if n_steps == 0:
        n_steps = len(assistant_msgs)
    reply_snippet = snippet(first_reply, 110) if first_reply else "（未输出文本回复）"

    meta = []
    if n_steps:
        meta.append(f'<span class="stat">{n_steps} 步</span>')
    if n_tools:
        meta.append(f'<span class="stat">{n_tools} 次工具调用</span>')
    if n_reason:
        meta.append(f'<span class="stat">{n_reason} 段思考</span>')

    chev = ('<span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>')

    h = [f'<details class="round" id="round-{idx}">',
         f'<summary>{chev}<span class="round-head">'
         f'<div class="round-q"><span class="u">回合 {idx} · 用户</span>{esc(snippet(u_text, 120))}</div>'
         f'<div class="round-a">🤖 {esc(reply_snippet)}</div>'
         f'<div class="round-meta">{"".join(meta)}</div></span></summary>',
         '<div class="round-body">',
         f'<div class="user-full">{esc(u_text)}</div>',
         '<div class="assist-label">助手执行过程</div>']
    h.extend(body)
    h.append('</div></details>')
    return "\n".join(h)


def render_html(sess, msgs, conn):
    rounds = split_rounds(msgs)
    model = sess.get("model")
    if isinstance(model, dict):
        model = model.get("modelID", "")
    body = []
    body.append(f'<header class="card">'
                f'<div class="breadcrumb"><a href="index.html">← 全部会话</a></div>'
                f'<h1>{esc(sess["title"] or "(无标题)")}</h1>'
                f'<div class="chips">'
                f'<span class="chip">会话 <b><span class="code">{esc(sess["id"])}</span></b></span>'
                f'<span class="chip">创建 <b>{esc(ts_to_str(sess.get("time_created")))}</b></span>'
                f'<span class="chip">模型 <b>{esc(model or "N/A")}</b></span>'
                f'<span class="chip">成本 <b>${sess.get("cost") or 0:.6f}</b></span>'
                f'<span class="chip">tokens <b>{sess.get("tokens_input") or 0} 入 / {sess.get("tokens_output") or 0} 出</b></span>'
                f'<span class="chip">回合 <b>{len(rounds)}</b></span>'
                f'</div></header>')

    body.append('<div class="toolbar">'
                '<span class="counter">共 %d 个回合 · 点击展开查看细节</span><span class="spacer"></span>'
                '<button class="md tonal" onclick="setAll(true)">全部展开</button>'
                '<button class="md filled" onclick="setAll(false)">全部折叠</button>'
                '</div>' % len(rounds))

    body.append('<div class="tree">')
    for i, (u, assists) in enumerate(rounds, 1):
        body.append(round_html(conn, i, u, assists))
    body.append('</div>')

    js = ("<script>function setAll(open){document.querySelectorAll('details').forEach(function(d){"
          "if(!d.classList.contains('out-long')){d.open=open;}})}</script>")
    footer = '<footer>由 opencode_audit.py 生成 · 数据来源 opencode.db</footer>'
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(sess['title'] or '会话审计')}</title>
<style>{MATERIAL_CSS}</style></head>
<body><div class="wrap">{''.join(body)}</div>{js}{footer}</body></html>"""


def render_index(sessions, out_dir):
    rows = []
    for s in sessions:
        sid = esc(s["id"])
        html_f = esc(s["id"] + ".html")
        model = s.get("model")
        if isinstance(model, dict):
            model = model.get("modelID", "")
        rows.append(
            f'<div class="row">'
            f'<div class="row-time">{esc(ts_to_str(s.get("time_created")))}</div>'
            f'<div class="row-title"><a href="{html_f}">{esc(s["title"] or "(无标题)")}</a></div>'
            f'<div class="row-meta"><span class="code">{sid}</span> · {esc(model or "N/A")} · ${s.get("cost") or 0:.6f}</div>'
            f'</div>')
    css = f"""
    {MATERIAL_CSS}
    .list{{display:flex;flex-direction:column;gap:12px}}
    .row{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      box-shadow:var(--shadow);padding:16px 20px;transition:.15s}}
    .row:hover{{box-shadow:var(--shadow-2);transform:translateY(-1px)}}
    .row-time{{font-size:12px;color:var(--text-3);margin-bottom:4px}}
    .row-title{{font-size:16px;font-weight:600;margin-bottom:6px}}
    .row-title a{{color:var(--text);text-decoration:none}}
    .row-title a:hover{{color:var(--md-primary-2)}}
    .row-meta{{font-size:12.5px;color:var(--text-2)}}
    """
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>opencode 会话审计</title>
<style>{css}</style></head><body><div class="wrap">
<header class="card"><h1>opencode 会话审计</h1>
<div class="chips"><span class="chip">共 <b>{len(sessions)}</b> 个会话</span></div></header>
<div class="list">{''.join(rows)}</div>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="opencode 会话审计导出")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--session", default=None)
    ap.add_argument("--format", default="html", choices=["md", "html", "both"])
    args = ap.parse_args()

    conn = connect(args.db)
    sessions = load_sessions(conn, args.session)
    if not sessions:
        sys.exit("未找到会话。")

    os.makedirs(args.out, exist_ok=True)
    for s in sessions:
        msgs = load_messages(conn, s["id"])
        base = os.path.join(args.out, s["id"])
        if args.format in ("html", "both"):
            h = render_html(s, msgs, conn)
            with open(base + ".html", "w", encoding="utf-8") as f:
                f.write(h)
            print(f"✓ HTML: {base}.html ({len(h)} 字符)")
        if args.format in ("md", "both"):
            md = render_markdown(s, msgs, conn)
            with open(base + ".md", "w", encoding="utf-8") as f:
                f.write(md)
            print(f"✓ Markdown: {base}.md ({len(md)} 字符)")

    if args.session is None:
        with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as f:
            f.write(render_index(sessions, args.out))
        print(f"✓ 索引: {os.path.join(args.out, 'index.html')}")

    print(f"\n输出目录: {args.out}")
    conn.close()


if __name__ == "__main__":
    main()
