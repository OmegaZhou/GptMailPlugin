#!/usr/bin/env python3
"""Run on the server as root: HTTPS OAuth/MCP smoke, without sending or modifying mail."""
import argparse
import base64
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def verify(config_path: Path, restart: bool) -> None:
    config = json.loads(config_path.read_text())
    origin = config["http"]["publicUrl"]
    prefix = config["oauth"].get("routePrefix", "")
    resource = origin + config["oauth"]["mcpPath"]
    issuer = origin + (prefix or "/")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(path, body=None, headers=None, form=False):
        headers = dict(headers or {})
        data = None
        if body is not None:
            data = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        req = urllib.request.Request(origin + path, data=data, headers=headers)
        try:
            with opener.open(req, timeout=15) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as response:
            return response.code, response.headers, response.read()
    def parsed(path, body=None, headers=None, form=False):
        status, _, raw = request(path, body, headers, form)
        assert status in (200, 201), f"Unexpected HTTP {status} for {path}"
        return json.loads(raw)
    metadata = parsed("/.well-known/oauth-protected-resource" + config["oauth"]["mcpPath"])
    assert metadata["resource"] == resource and metadata["authorization_servers"] == [issuer]
    auth_metadata = parsed("/.well-known/oauth-authorization-server" + prefix)
    assert auth_metadata["issuer"] == issuer
    assert auth_metadata["token_endpoint"] == origin + prefix + "/token"
    status, headers, _ = request(config["oauth"]["mcpPath"], {})
    assert status == 401 and "resource_metadata=" in headers["WWW-Authenticate"]
    client = parsed(prefix + "/register", {"client_name": "GptMail deployment verification", "redirect_uris": ["https://chatgpt.com/connector/oauth/deployment-verification"],
        "token_endpoint_auth_method": "client_secret_post", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]})
    credentials = {"client_id": client["client_id"], "client_secret": client["client_secret"]}
    refresh = None
    try:
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        state = secrets.token_urlsafe(24)
        query = urllib.parse.urlencode({"client_id": client["client_id"], "redirect_uri": client["redirect_uris"][0], "response_type": "code",
            "code_challenge_method": "S256", "code_challenge": challenge, "scope": "mail.read", "state": state, "resource": resource})
        status, headers, html = request(prefix + "/authorize?" + query)
        assert status == 200 and "Secure" in headers["Set-Cookie"]
        nonce = re.search(r'name="nonce" value="([^"]+)"', html.decode())[1]
        status, headers, _ = request(prefix + "/oauth/approve", {"nonce": nonce, "apiKey": config["apiKey"], "decision": "approve"}, {"Origin": origin}, form=True)
        assert status == 303
        callback = urllib.parse.parse_qs(urllib.parse.urlparse(headers["Location"]).query)
        assert callback["state"] == [state]
        tokens = parsed(prefix + "/token", {**credentials, "grant_type": "authorization_code", "code": callback["code"][0], "code_verifier": verifier,
            "redirect_uri": client["redirect_uris"][0], "resource": resource}, form=True)
        refresh = tokens["refresh_token"]
        def rpc(method, params, token):
            result = parsed(config["oauth"]["mcpPath"], {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                {"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream"})
            assert "result" in result and "error" not in result, "MCP response failed"
            return result["result"]
        initialized = rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "deployment-verify", "version": "1.0.0"}}, tokens["access_token"])
        tools = rpc("tools/list", {}, tokens["access_token"])["tools"]
        assert len(tools) == 21 and all(t.get("securitySchemes") for t in tools)
        accounts = rpc("tools/call", {"name": "list_accounts", "arguments": {}}, tokens["access_token"])
        assert not accounts.get("isError"), "Account listing failed"
        if restart:
            subprocess.run(["systemctl", "restart", "gpt-mail.service"], check=True, stdout=subprocess.DEVNULL)
            for _ in range(30):
                try:
                    if request(prefix + "/healthz")[0] == 200:
                        break
                except (urllib.error.URLError, TimeoutError):
                    pass
                time.sleep(0.25)
            rpc("tools/list", {}, tokens["access_token"])
        rotated = parsed(prefix + "/token", {**credentials, "grant_type": "refresh_token", "refresh_token": refresh, "resource": resource}, form=True)
        refresh = rotated["refresh_token"]
        assert refresh != tokens["refresh_token"]
        rpc("tools/list", {}, rotated["access_token"])
        status, _, _ = request(prefix + "/revoke", {**credentials, "token": refresh}, form=True)
        assert status == 200
        refresh = None
        status, _, _ = request(config["oauth"]["mcpPath"], {}, {"Authorization": "Bearer " + rotated["access_token"]})
        assert status == 401
        print(json.dumps({"https_oauth_mcp": "passed", "version": initialized["serverInfo"]["version"], "tools": len(tools),
            "configured_accounts": len(accounts["structuredContent"]["accounts"]), "restart_checked": restart, "test_grant": "revoked"}))
    finally:
        if refresh:
            request(prefix + "/revoke", {**credentials, "token": refresh}, form=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("/etc/gpt-mail/config.json"))
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args()
    verify(args.config, args.restart)
