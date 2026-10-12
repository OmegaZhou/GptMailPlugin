#!/usr/bin/env python3
"""Register an issuer's account with GptMail without modifying the issuer."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registration', required=True)
    parser.add_argument('--config', default='/etc/gpt-mail/config.json')
    parser.add_argument('--provider', default='/etc/gpt-mail/provider.json')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run as root')
    os.umask(0o077)
    registration = json.loads(Path(args.registration).read_text())
    subject, username = registration['subject'], registration['username']
    if not isinstance(subject, str) or not 0 < len(subject) <= 512 or not isinstance(username, str) or not 0 < len(username) <= 100:
        raise ValueError('Invalid account registration')
    path, provider_path = Path(args.config), Path(args.provider)
    original = path.read_bytes()
    config = json.loads(original)
    provider = config['oauth']['provider']
    provider['allowedSubjects'] = [subject]
    provider['accountNames'] = {subject: username}
    backup_root = Path('/var/backups/gpt-mail')
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='account-', dir=backup_root))
    shutil.copy2(path, backup / 'config.json')
    existed = provider_path.exists()
    if existed:
        shutil.copy2(provider_path, backup / 'provider.json')

    def write(target, value):
        stat = path.stat()
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temporary, stat.st_uid, stat.st_gid)
        os.chmod(temporary, 0o640)
        os.replace(temporary, target)

    try:
        if path.read_bytes() != original:
            raise RuntimeError('Configuration changed concurrently')
        write(path, config)
        write(provider_path, provider)
        subprocess.run(['systemctl', 'restart', 'gpt-mail'], check=True, capture_output=True)
        subprocess.run(['systemctl', 'is-active', '--quiet', 'gpt-mail'], check=True)
    except BaseException:
        shutil.copy2(backup / 'config.json', path)
        if existed:
            shutil.copy2(backup / 'provider.json', provider_path)
        else:
            provider_path.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'restart', 'gpt-mail'], check=False, capture_output=True)
        raise
    print('GptMail account registration updated. Issuer configuration was not modified.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Application account registration failed; private details suppressed.')
