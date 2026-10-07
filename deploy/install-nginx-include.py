#!/usr/bin/env python3
"""Insert one include in the existing canonical HTTPS vhost, without changing other sites."""
from pathlib import Path
import sys

def install(path: Path, hostname: str) -> None:
    text = path.read_text(encoding="utf-8")
    marker = f"server_name {hostname};"
    if text.count(marker) != 1:
        raise RuntimeError("Expected exactly one matching HTTPS server block")
    start = text.rfind("server {", 0, text.index(marker))
    if start < 0:
        raise RuntimeError("Server block not found")
    brace = text.index("{", start)
    depth = 0
    for index in range(brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                block = text[start:index]
                if "listen 443" not in block:
                    raise RuntimeError("Canonical server is not HTTPS")
                include = "include /etc/nginx/snippets/gpt-mail.conf;"
                if include not in block:
                    path.write_text(text[:index] + "    " + include + "\n" + text[index:], encoding="utf-8")
                return
    raise RuntimeError("Unclosed server block")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: install-nginx-include.py SITE_FILE HOSTNAME")
    install(Path(sys.argv[1]), sys.argv[2])
