#!/usr/bin/env python3
"""Read-only discovery checks; not proof of ChatGPT login or mailbox acceptance."""
import argparse
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def verify(config_path):
    config = json.loads(config_path.read_text())
    provider = config['oauth']['provider']
    origin = config['http']['publicUrl'].rstrip('/')
    resource = origin + config['oauth']['mcpPath']
    assert provider['resource'] == resource, 'Configured resource mismatch'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def request(url, body=None):
        parsed = urllib.parse.urlsplit(url)
        assert parsed.scheme == 'https' and not parsed.username and not parsed.password, 'HTTPS required'
        headers = {'Accept': 'application/json, text/event-stream'}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        try:
            with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=15) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as response:
            return response.code, response.headers, response.read()
    def document(url):
        status, _, raw = request(url)
        assert status == 200, 'Discovery HTTP check failed'
        return json.loads(raw)
    metadata = document(origin + '/.well-known/oauth-protected-resource' + config['oauth']['mcpPath'])
    assert metadata['resource'] == resource, 'Discovered resource mismatch'
    assert metadata['authorization_servers'] == [provider['issuer']], 'Authorization issuer mismatch'
    assert {'openid', 'offline_access', 'mail.read', 'mail.write'} <= set(metadata['scopes_supported']), 'Required scopes missing'
    discovery = document(provider['issuer'].rstrip('/') + '/.well-known/openid-configuration')
    assert discovery['issuer'] == provider['issuer'], 'OIDC issuer mismatch'
    assert discovery['jwks_uri'] == provider['jwksUrl'], 'JWKS endpoint mismatch'
    assert 'S256' in discovery['code_challenge_methods_supported'], 'PKCE S256 missing'
    assert 'refresh_token' in discovery['grant_types_supported'], 'Refresh grant missing'
    keys = document(provider['jwksUrl'])['keys']
    assert any(key.get('kty') == 'RSA' and key.get('alg') == 'RS256' for key in keys), 'Signing key missing'
    status, headers, _ = request(resource, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}})
    assert status == 401 and 'resource_metadata=' in headers.get('WWW-Authenticate', ''), 'Unauthenticated MCP must reject access'
    return {'external_discovery': 'passed', 'unauthenticated_mcp': 'rejected',
            'authenticated_mcp': 'not_checked', 'chatgpt_ui': 'not_checked',
            'token_refresh': 'not_checked', 'real_mail': 'not_checked'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/gpt-mail/config.json'))
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.config)))
    except Exception as error:
        # Network exceptions and response bodies may expose private addresses.
        message = str(error) if isinstance(error, AssertionError) else type(error).__name__
        print(json.dumps({'verification': 'failed', 'reason': message}), file=sys.stderr)
        sys.exit(1)
