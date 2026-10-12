#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
BUNDLE="$(realpath "${1:?usage: deploy.sh BUNDLE_DIR}")"
SITE="${MAIL_NGINX_SITE:?Set MAIL_NGINX_SITE to the private Nginx site path}"
PUBLIC_ORIGIN="${MAIL_PUBLIC_ORIGIN:?Set MAIL_PUBLIC_ORIGIN to the public HTTPS origin}"
PUBLIC_HOST="$(python3 - "$PUBLIC_ORIGIN" <<'PY'
import re, sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
assert u.scheme == "https" and u.hostname and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", u.hostname), "Invalid public HTTPS origin"
assert not u.username and not u.password and not u.query and not u.fragment and u.path in ("", "/") and u.port in (None, 443), "Supply an HTTPS origin on port 443"
print(u.hostname)
PY
)"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
AUTH_PROVIDER_CONFIG="${MAIL_AUTH_PROVIDER_CONFIG:?Set MAIL_AUTH_PROVIDER_CONFIG to the private external authentication settings file}"
# Validate the replacement authentication before changing the running application.
python3 - "$AUTH_PROVIDER_CONFIG" "$PUBLIC_ORIGIN" <<'PY'
import json, pathlib, sys, urllib.parse, urllib.request
provider = json.loads(pathlib.Path(sys.argv[1]).read_text())
required = {"issuer", "jwksUrl", "resource", "clientId", "allowedSubjects"}
assert required <= set(provider) <= required | {"accountNames"}, "Invalid authentication provider fields"
names = provider.get("accountNames", {})
assert isinstance(names, dict) and all(k in provider["allowedSubjects"] and isinstance(v, str) and 0 < len(v.strip()) <= 100 for k, v in names.items()), "Invalid account display names"
for name in ("issuer", "jwksUrl", "resource"):
    u = urllib.parse.urlsplit(provider[name])
    assert u.scheme == "https" and u.netloc and not u.username and not u.password and not u.query and not u.fragment, "Invalid authentication endpoint"
assert provider["resource"] == sys.argv[2] + "/mail-mcp", "Authentication resource mismatch"
assert isinstance(provider["clientId"], str) and provider["clientId"], "Missing registered client"
assert isinstance(provider["allowedSubjects"], list) and 0 < len(provider["allowedSubjects"]) <= 10, "Missing authorized account"
assert all(isinstance(s, str) and s and not s.startswith("REPLACE_") for s in provider["allowedSubjects"]), "Account setup is incomplete"
try:
    metadata = json.load(urllib.request.urlopen(provider["issuer"].rstrip("/") + "/.well-known/openid-configuration", timeout=10))
    assert metadata["issuer"] == provider["issuer"] and metadata["jwks_uri"] == provider["jwksUrl"]
except Exception:
    raise SystemExit("Authentication discovery preflight failed; private details suppressed")
print("External authentication discovery preflight passed")
PY
APP=/opt/gpt-mail
CONFIG=/etc/gpt-mail
STATE=/var/lib/gpt-mail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/var/backups/gpt-mail/${STAMP}"
for tool in python3 nginx systemctl curl sha256sum; do command -v "$tool" >/dev/null; done
test -x /usr/local/bin/node
test -f "$SITE"
/usr/local/bin/node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)'
python3 - "$BUNDLE" <<'PY'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
m = json.loads((p / "manifest.json").read_text())
expected = {"server.cjs", "server.cjs.LEGAL.txt", "config.example.json", "deploy.sh", "gpt-mail.service", "nginx-gpt-mail.conf", "nginx-gpt-mail-proxy.conf", "install-nginx-include.py", "migrate-storage.mjs"}
assert set(m["files"]) == expected, "Invalid bundle file list"
for name, digest in m["files"].items():
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == digest, "Bundle integrity check failed"
print("Verified deployment bundle", m["version"])
PY
nginx -t
install -d -m 0700 "$BACKUP"
cp -a "$SITE" "$BACKUP/site.conf"
for name in gpt-mail.conf gpt-mail-proxy.conf; do
  [[ ! -f /etc/nginx/snippets/$name ]] || cp -a "/etc/nginx/snippets/$name" "$BACKUP/$name"
done
[[ ! -f /etc/systemd/system/gpt-mail.service ]] || cp -a /etc/systemd/system/gpt-mail.service "$BACKUP/gpt-mail.service"
[[ ! -f "$CONFIG/config.json" ]] || cp -a "$CONFIG/config.json" "$BACKUP/config.json"
PREVIOUS="$(readlink -f "$APP/current" 2>/dev/null || true)"
WAS_ACTIVE=false
WAS_ENABLED=false
systemctl is-active --quiet gpt-mail.service && WAS_ACTIVE=true || true
[[ -f /etc/systemd/system/gpt-mail.service ]] && systemctl is-enabled --quiet gpt-mail.service && WAS_ENABLED=true || true

rollback() {
  local result=$?
  trap - ERR
  set +e
  echo "Deployment failed near line ${BASH_LINENO[0]}; restoring previous application and Nginx configuration" >&2
  systemctl stop gpt-mail.service
  [[ "$WAS_ENABLED" == true ]] || systemctl disable gpt-mail.service >/dev/null 2>&1
  cp -a "$BACKUP/site.conf" "$SITE"
  for name in gpt-mail.conf gpt-mail-proxy.conf; do
    if [[ -f "$BACKUP/$name" ]]; then cp -a "$BACKUP/$name" "/etc/nginx/snippets/$name"; else rm -f -- "/etc/nginx/snippets/$name"; fi
  done
  if [[ -f "$BACKUP/gpt-mail.service" ]]; then cp -a "$BACKUP/gpt-mail.service" /etc/systemd/system/gpt-mail.service; else rm -f -- /etc/systemd/system/gpt-mail.service; fi
  [[ ! -f "$BACKUP/config.json" ]] || cp -a "$BACKUP/config.json" "$CONFIG/config.json"
  if [[ -f "$BACKUP/settings.enc.json" ]]; then cp -a "$BACKUP/settings.enc.json" "$STATE/panel/settings.enc.json"; fi
  if [[ -n "$PREVIOUS" ]]; then ln -sfn "$PREVIOUS" "$APP/current"; else [[ ! -L "$APP/current" ]] || rm -f -- "$APP/current"; fi
  systemctl daemon-reload
  [[ "$WAS_ACTIVE" != true ]] || systemctl start gpt-mail.service
  nginx -t && systemctl reload nginx
  exit "$result"
}
trap rollback ERR
# Freeze encrypted state before backing it up and rotating its encryption key.
systemctl stop gpt-mail.service 2>/dev/null || { [[ "$WAS_ACTIVE" == false ]] || false; }
[[ ! -f "$STATE/panel/settings.enc.json" ]] || cp -a "$STATE/panel/settings.enc.json" "$BACKUP/settings.enc.json"
/usr/local/bin/node "$BUNDLE/migrate-storage.mjs" "$CONFIG/config.json" "$STATE/panel/settings.enc.json"
[[ ! -f "$STATE/panel/settings.enc.json" ]] || chown gpt-mail:gpt-mail "$STATE/panel/settings.enc.json"

id -u gpt-mail >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin gpt-mail
install -d -m 0755 "$APP" "$APP/releases"
install -d -o gpt-mail -g gpt-mail -m 0700 "$STATE"
install -d -o root -g gpt-mail -m 0750 "$CONFIG"
RELEASE="$APP/releases/$STAMP"
install -d -m 0755 "$RELEASE"
install -m 0644 "$BUNDLE/server.cjs" "$BUNDLE/server.cjs.LEGAL.txt" "$BUNDLE/manifest.json" "$RELEASE/"
install -m 0644 "$BUNDLE/config.example.json" "$CONFIG/config.example.json"
python3 - "$CONFIG/config.json" "$PUBLIC_ORIGIN" "$AUTH_PROVIDER_CONFIG" <<'PY'
import json, pathlib, secrets, sys
p = pathlib.Path(sys.argv[1])
config = json.loads(p.read_text()) if p.exists() else {"storageKey": secrets.token_urlsafe(32), "mail": {"accounts": [], "maxMessageBytes": 26214400}}
assert "apiKey" not in config and len(config["storageKey"]) >= 32, "Invalid storage encryption configuration"
config["http"] = {**config.get("http", {}), "publicUrl": sys.argv[2], "bindHost": "127.0.0.1", "port": 18082, "trustProxy": 1, "allowedOrigins": ["https://chatgpt.com"]}
config["oauth"] = {"enabled": True, "mcpPath": "/mail-mcp", "routePrefix": "/mail-mcp", "provider": json.loads(pathlib.Path(sys.argv[3]).read_text())}
p.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
PY
if [[ ! -f "$CONFIG/mail.env" ]]; then
  printf '%s\n' '# Set mailbox passwordEnv/accessTokenEnv variables here. Never store secrets in Git.' > "$CONFIG/mail.env"
fi
chown root:gpt-mail "$CONFIG/config.json" "$CONFIG/mail.env"
chmod 0640 "$CONFIG/config.json" "$CONFIG/mail.env"
ln -sfn "releases/$STAMP" "$APP/current"
install -m 0644 "$BUNDLE/gpt-mail.service" /etc/systemd/system/gpt-mail.service
install -m 0644 "$BUNDLE/nginx-gpt-mail.conf" /etc/nginx/snippets/gpt-mail.conf
install -m 0644 "$BUNDLE/nginx-gpt-mail-proxy.conf" /etc/nginx/snippets/gpt-mail-proxy.conf
python3 "$BUNDLE/install-nginx-include.py" "$SITE" "$PUBLIC_HOST" "$BACKUP/gpt-mail.conf"
nginx -t
systemctl daemon-reload
systemctl enable gpt-mail.service
systemctl restart gpt-mail.service
ready=false
for attempt in {1..40}; do
  if curl --noproxy '*' --fail --silent --max-time 3 -H "Host: $PUBLIC_HOST" http://127.0.0.1:18082/mail-mcp/healthz >/dev/null; then ready=true; break; fi
  sleep 0.25
done
[[ "$ready" == true ]]
systemctl reload nginx
ready=false
for attempt in {1..40}; do
  if curl --noproxy '*' --fail --silent --max-time 3 --resolve "$PUBLIC_HOST:443:127.0.0.1" "$PUBLIC_ORIGIN/mail-mcp/healthz" >/dev/null &&
     curl --noproxy '*' --fail --silent --max-time 3 --resolve "$PUBLIC_HOST:443:127.0.0.1" "$PUBLIC_ORIGIN/.well-known/oauth-protected-resource/mail-mcp" >/dev/null; then ready=true; break; fi
  sleep 0.25
done
[[ "$ready" == true ]]
systemctl is-active --quiet gpt-mail.service nginx
trap - ERR
echo "Deployed $RELEASE"
echo 'ChatGPT OAuth endpoint configured at /mail-mcp; origin is in the private server configuration.'
echo 'Private config: /etc/gpt-mail/config.json; mailbox environment: /etc/gpt-mail/mail.env'
echo "Rollback backup: $BACKUP"
