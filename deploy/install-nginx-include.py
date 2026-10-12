#!/usr/bin/env python3
"""Insert one include in the existing canonical HTTPS vhost, without changing other sites."""
from pathlib import Path
import sys
import re

def inherited_includes(previous: Path) -> list[str]:
    """Keep independently deployed services that an older mail snippet included."""
    if not previous.exists():
        return []
    depth = 0
    includes = []
    for line in previous.read_text(encoding="utf-8").splitlines():
        code = line.split("#", 1)[0]
        if depth == 0:
            match = re.fullmatch(r"\s*include\s+(/etc/nginx/snippets/[A-Za-z0-9_.-]+\.conf);\s*", code)
            if match and match.group(1) != "/etc/nginx/snippets/gpt-mail.conf":
                includes.append(match.group(1))
        depth += code.count("{") - code.count("}")
    return list(dict.fromkeys(includes))

def install(path: Path, hostname: str, additional: list[str] | None = None) -> None:
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
                additions = ["/etc/nginx/snippets/gpt-mail.conf", *(additional or [])]
                missing = [f"include {name};" for name in additions if f"include {name};" not in block]
                if missing:
                    path.write_text(text[:index] + "".join("    " + line + "\n" for line in missing) + text[index:], encoding="utf-8")
                return
    raise RuntimeError("Unclosed server block")

if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: install-nginx-include.py SITE_FILE HOSTNAME [PREVIOUS_MAIL_SNIPPET]")
    inherited = inherited_includes(Path(sys.argv[3])) if len(sys.argv) == 4 else []
    install(Path(sys.argv[1]), sys.argv[2], inherited)
