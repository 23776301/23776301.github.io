#!/bin/bash
# opencode-session-viewer installer
# Usage: curl -fsSL <url>/install.sh | bash

set -e

INSTALL_DIR="$HOME/.local/bin"
BASHRC="$HOME/.bashrc"

echo "Installing opencode-session-viewer..."

# Create directory
mkdir -p "$INSTALL_DIR"

# Write sss.py
cat > "$INSTALL_DIR/sss.py" << 'PYEOF'
#!/usr/bin/env python3
import sqlite3
import json
import argparse
import os
import sys
import signal
from datetime import datetime

DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")
MAX_WIDTH = 80
TIMEOUT = 3

def timeout_handler(signum, frame):
    print("Error: database query timeout")
    sys.exit(1)

signal.signal(signal.SIGALRM, timeout_handler)

# ANSI colors
GREEN = "\033[32m"
YELLOW = "\033[38;5;228m"
WHITE = "\033[38;5;252m"
GRAY = "\033[38;5;245m"
BLUE = "\033[38;5;117m"
RESET = "\033[0m"
BOLD = "\033[1m"

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
    
    cursor.execute("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC", (session_id,))
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
    dt = datetime.fromtimestamp(ts_ms / 1000 + 8*3600)
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
    
    for i in range(total - 1, -1, -1):
        session_id, title, time_created, time_updated = sessions[i]
        signal.alarm(TIMEOUT)
        last_msg_time = get_last_message_time(session_id)
        qa_pairs = get_qa_pairs(session_id, interactions)
        signal.alarm(0)
        print_session(i, session_id, title, time_created, qa_pairs, last_msg_time)
        print()

def cmd_enter(index):
    signal.alarm(TIMEOUT)
    sessions = get_sessions(100)
    signal.alarm(0)
    
    total = len(sessions)
    if index < 0 or index >= total:
        print(f"Error: index {index} out of range (0-{total-1})")
        sys.exit(1)
    
    session_id = sessions[index][0]
    os.execvp("opencode", ["opencode", "-s", session_id])

def main():
    parser = argparse.ArgumentParser(description="Show recent opencode sessions")
    parser.add_argument("-c", "--count", type=int, default=10, help="Number of sessions to show (default: 10)")
    parser.add_argument("-n", "--interactions", type=int, default=5, help="Number of QA interactions per session (default: 5)")
    parser.add_argument("action", nargs="?", help="'in' to enter a session")
    parser.add_argument("index", nargs="?", type=int, help="Session index to enter")
    args = parser.parse_args()
    
    if args.action == "in":
        if args.index is None:
            print("Usage: sss in <index>")
            sys.exit(1)
        cmd_enter(args.index)
    else:
        cmd_list(args.count, args.interactions)

if __name__ == "__main__":
    main()
PYEOF

chmod +x "$INSTALL_DIR/sss.py"

# Add to bashrc if not already present
if ! grep -q "opencode session history viewer" "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" << 'BASHEOF'

# opencode session history viewer
sss() {
    if [ "$1" = "in" ] && [ -n "$2" ]; then
        local session_id=$(timeout 3 python3 -c "
import sqlite3, sys
conn = sqlite3.connect('$HOME/.local/share/opencode/opencode.db')
cursor = conn.cursor()
cursor.execute('SELECT s.id FROM session s LEFT JOIN (SELECT session_id, MAX(time_created) as last_msg_time FROM message GROUP BY session_id) m ON s.id = m.session_id ORDER BY COALESCE(m.last_msg_time, s.time_updated, s.time_created) DESC')
sessions = cursor.fetchall()
index = int(sys.argv[1])
if 0 <= index < len(sessions):
    print(sessions[index][0])
else:
    print('ERROR', file=sys.stderr)
    sys.exit(1)
conn.close()
" "$2")
        if [ $? -eq 0 ] && [ -n "$session_id" ]; then
            opencode -s "$session_id"
        else
            echo "Error: invalid index $2"
        fi
    else
        timeout 3 python3 $HOME/.local/bin/sss.py "$@"
    fi
}
complete -W "in" sss
BASHEOF
fi

echo "Installed successfully!"
echo "Run: source ~/.bashrc"
