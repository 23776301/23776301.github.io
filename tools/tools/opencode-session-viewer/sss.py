#!/usr/bin/env python3
"""opencode 会话历史查看器 + HTML 审计报告生成。

用法:
  sss                    列出最近的会话
  sss -c <n>             列出最近 n 个会话
  sss -n <m>             每个会话显示 m 轮问答
  sss in <索引>           进入指定索引的会话 (opencode -s)
  sss <索引>              为指定索引的会话生成 HTML 审计报告
  sss audit <索引>        同上（生成 HTML 审计报告）
  sss -d <索引>           删除指定索引的会话（-y 跳过确认）
"""
import sqlite3
import json
import os
import sys
import signal
import subprocess
from datetime import datetime

DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")
MAX_WIDTH = 80
TIMEOUT = 3


def timeout_handler(signum, frame):
    print("Error: database query timeout")
    sys.exit(1)


signal.signal(signal.SIGALRM, timeout_handler)

GREEN = "\033[32m"
YELLOW = "\033[38;5;228m"
WHITE = "\033[38;5;252m"
GRAY = "\033[38;5;245m"
BLUE = "\033[38;5;117m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"


def usage():
    print(f"{BOLD}用法:{RESET}")
    print("  sss                   列出最近的会话")
    print("  sss -c <n>            列出最近 n 个会话")
    print("  sss -n <m>            每个会话显示 m 轮问答")
    print("  sss in <索引>         进入指定索引的会话（opencode -s）")
    print("  sss <索引>            为指定索引的会话生成 HTML 审计报告")
    print("  sss audit <索引>      同上（生成 HTML 审计报告）")
    print("  sss -d <索引>         删除指定索引的会话（-y 跳过确认）")
    print(f"{GRAY}索引从 0 开始，0 为最新会话；显示列表时最左侧 [n] 即为索引。{RESET}")


def truncate(text, max_len=MAX_WIDTH):
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."


def truncate_lines(text, max_lines=3, max_width=MAX_WIDTH):
    lines = text.split("\n")
    result = []
    for i, line in enumerate(lines):
        if i >= max_lines:
            result.append(truncate("...", max_width))
            break
        result.append(truncate(line, max_width))
    return "\n".join(result)


def get_sessions(count):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT s.id, s.title, s.time_created, s.time_updated
        FROM session s
        LEFT JOIN (
            SELECT session_id, MAX(time_created) as last_msg_time
            FROM message
            GROUP BY session_id
        ) m ON s.id = m.session_id
        ORDER BY COALESCE(m.last_msg_time, s.time_updated, s.time_created) DESC
        LIMIT ?
    """, (count,))
    sessions = cursor.fetchall()
    conn.close()
    return sessions


def get_last_message_time(session_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT MAX(time_created) FROM message WHERE session_id = ?", (session_id,))
    result = cursor.fetchone()
    conn.close()
    return result[0] if result and result[0] else None


def get_qa_pairs(session_id, count):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, data FROM message WHERE session_id = ? "
                   "ORDER BY time_created DESC", (session_id,))
    messages = cursor.fetchall()
    qa_pairs = []
    current_pair = {}
    for msg_id, msg_data in messages:
        data = json.loads(msg_data)
        role = data.get("role", "unknown")
        cursor.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (msg_id,))
        parts = cursor.fetchall()
        text_parts = []
        for part_data, in parts:
            part = json.loads(part_data)
            part_type = part.get("type")
            if part_type in ("text", "reasoning"):
                text_parts.append(part.get("text", ""))
        content = "\n".join(text_parts)
        if role == "user":
            current_pair["user"] = content
            if "assistant" in current_pair:
                qa_pairs.append(current_pair)
                current_pair = {}
        elif role == "assistant":
            current_pair["assistant"] = content
    if "user" in current_pair and "assistant" in current_pair:
        qa_pairs.append(current_pair)
    conn.close()
    return qa_pairs[:count]


def format_time(ts_ms):
    if not ts_ms:
        return "N/A"
    dt = datetime.fromtimestamp(ts_ms / 1000 + 8 * 3600)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def print_session(index, session_id, title, time_created, qa_pairs, last_msg_time):
    print(f"{YELLOW}[{index}] {truncate(title, 40)}{RESET} {GREEN}{session_id}{RESET}")
    print(f"{BLUE}Last: {format_time(last_msg_time)}{RESET}")
    if not qa_pairs:
        print(f"{GRAY}  (no interactions){RESET}")
        return
    for j, pair in enumerate(qa_pairs):
        if "user" in pair and pair["user"]:
            user_text = truncate_lines(pair["user"], max_lines=2)
            print(f"{WHITE}  [Q]: {user_text}{RESET}")
        if "assistant" in pair and pair["assistant"]:
            asst_text = truncate_lines(pair["assistant"], max_lines=2)
            print(f"{GRAY}  [A]: {asst_text}{RESET}")


def cmd_list(count, interactions):
    signal.alarm(TIMEOUT)
    sessions = get_sessions(count)
    signal.alarm(0)
    total = len(sessions)
    if total == 0:
        print("(no sessions)")
        return
    for i in range(total - 1, -1, -1):
        session_id, title, time_created, time_updated = sessions[i]
        signal.alarm(TIMEOUT)
        last_msg_time = get_last_message_time(session_id)
        qa_pairs = get_qa_pairs(session_id, interactions)
        signal.alarm(0)
        print_session(i, session_id, title, time_created, qa_pairs, last_msg_time)
        print()


def resolve_session_id(index):
    sessions = get_sessions(100)
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    return sessions[index][0]


def cmd_enter(index):
    session_id = resolve_session_id(index)
    os.execvp("opencode", ["opencode", "-s", session_id])


def cmd_audit(index):
    sessions = get_sessions(100)
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    session_id, title = sessions[index][0], sessions[index][1]
    audit_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opencode_audit.py")
    html_path = os.path.join(os.path.expanduser("~/opencode-audit"), session_id + ".html")
    proc = subprocess.run(
        ["python3", audit_script, "--session", session_id, "--format", "html"],
        capture_output=True)
    if proc.returncode != 0:
        print(f"{RED}审计报告生成失败（退出码 {proc.returncode}）{RESET}")
        if proc.stderr:
            print(proc.stderr.decode("utf-8", "replace"))
        sys.exit(1)
    print(f"{YELLOW}[{index}] {title}{RESET} {GREEN}{session_id}{RESET}")
    print("的审计报告已经成功导出到")
    print(html_path)
    sys.exit(0)


def delete_session(session_id):
    """删除会话及其级联数据（message/part/todo/...），返回消息条数。"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys=ON")
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM message WHERE session_id = ?", (session_id,))
    n_msgs = cursor.fetchone()[0]
    cursor.execute("DELETE FROM session WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()
    return n_msgs


def cmd_delete(index, assume_yes):
    sessions = get_sessions(100)
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    session_id, title = sessions[index][0], sessions[index][1]
    if not assume_yes:
        try:
            answer = input(f"{YELLOW}删除会话 [{index}] {title} "
                           f"{GREEN}{session_id}{RESET}{YELLOW} ? [y/N] {RESET}")
        except EOFError:
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            print(f"{GRAY}已取消。{RESET}")
            return
    signal.alarm(TIMEOUT)
    n_msgs = delete_session(session_id)
    signal.alarm(0)
    html_path = os.path.join(os.path.expanduser("~/opencode-audit"), session_id + ".html")
    removed = False
    if os.path.exists(html_path):
        try:
            os.remove(html_path)
            removed = True
        except OSError:
            pass
    print(f"{YELLOW}[{index}] {title}{RESET} {GREEN}{session_id}{RESET}")
    print(f"{GREEN}已删除{RESET}（{n_msgs} 条消息）" + ("，并移除审计报告" if removed else ""))


def main():
    args = sys.argv[1:]
    if not args:
        cmd_list(10, 5)
        return
    first = args[0]
    if first == "in":
        if len(args) >= 2 and args[1].lstrip("-").isdigit():
            cmd_enter(int(args[1]))
        else:
            print(f"{RED}错误: 用法: sss in <索引>{RESET}")
            usage()
            sys.exit(1)
    elif first == "audit":
        if len(args) >= 2 and args[1].lstrip("-").isdigit():
            cmd_audit(int(args[1]))
        else:
            print(f"{RED}错误: 用法: sss audit <索引>{RESET}")
            usage()
            sys.exit(1)
    elif first in ("-d", "--delete", "delete"):
        if len(args) >= 2 and args[1].lstrip("-").isdigit():
            assume_yes = any(a in ("-y", "--yes", "-f", "--force") for a in args[2:])
            cmd_delete(int(args[1]), assume_yes)
        else:
            print(f"{RED}错误: 用法: sss -d <索引> [-y]{RESET}")
            usage()
            sys.exit(1)
    elif first.lstrip("-").isdigit():
        cmd_audit(int(first))
    elif first in ("-c", "--count", "-n", "--interactions", "-h", "--help"):
        count, interactions = 10, 5
        i = 0
        while i < len(args):
            a = args[i]
            if a in ("-c", "--count"):
                if i + 1 < len(args) and args[i + 1].isdigit():
                    count = int(args[i + 1]); i += 2
                else:
                    print(f"{RED}错误: {a} 需要一个数字参数{RESET}"); usage(); sys.exit(1)
            elif a in ("-n", "--interactions"):
                if i + 1 < len(args) and args[i + 1].isdigit():
                    interactions = int(args[i + 1]); i += 2
                else:
                    print(f"{RED}错误: {a} 需要一个数字参数{RESET}"); usage(); sys.exit(1)
            elif a in ("-h", "--help"):
                usage(); return
            else:
                print(f"{RED}错误: 无法识别的参数: {a}{RESET}"); usage(); sys.exit(1)
        cmd_list(count, interactions)
    else:
        print(f"{RED}错误: 无法识别的参数: {first}{RESET}")
        usage()
        sys.exit(1)


if __name__ == "__main__":
    main()
