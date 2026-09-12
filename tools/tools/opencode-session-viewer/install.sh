#!/bin/bash
# opencode-session-viewer installer
# Usage: curl -fsSL <url>/install.sh | bash
#   BASE_URL=<url> bash install.sh   # 从自定义地址安装（默认 down2.top）

set -e

INSTALL_DIR="$HOME/.local/bin"
BASHRC="$HOME/.bashrc"
BASE_URL="${BASE_URL:-https://down2.top/tools/tools/opencode-session-viewer}"

echo "Installing opencode-session-viewer..."
mkdir -p "$INSTALL_DIR"

# 下载最新脚本（带重试，网络不稳时更稳）
fetch() {
    local name="$1" url="$BASE_URL/$1" tmp
    tmp="$(mktemp)"
    local i
    for i in 1 2 3 4 5; do
        if curl -fsSL "$url" -o "$tmp"; then
            mv "$tmp" "$INSTALL_DIR/$name"
            return 0
        fi
        echo "  retry $i: $url" >&2
        sleep 2
    done
    rm -f "$tmp"
    echo "Error: failed to download $url" >&2
    return 1
}

fetch sss.py
fetch opencode_audit.py
chmod +x "$INSTALL_DIR/sss.py" "$INSTALL_DIR/opencode_audit.py"

# 移除旧的安装块（若存在），保证重复安装可升级
if grep -q "# >>> opencode-session-viewer >>>" "$BASHRC" 2>/dev/null; then
    sed -i '/# >>> opencode-session-viewer >>>/,/# <<< opencode-session-viewer <<</d' "$BASHRC"
fi

cat >> "$BASHRC" << 'BASHEOF'

# >>> opencode-session-viewer >>>
# opencode session history viewer
sss() {
    python3 "$HOME/.local/bin/sss.py" "$@"
}
complete -W "in audit delete" sss
# <<< opencode-session-viewer <<<
BASHEOF

echo "Installed successfully!"
echo "Run: source ~/.bashrc"
