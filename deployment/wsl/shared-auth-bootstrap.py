"""Bootstrap the shared gateway once, then switch Editor after its health check."""
from contextlib import closing
from pathlib import Path
import datetime, json, os, secrets, shutil, sqlite3, subprocess, sys, time, urllib.request

root = Path('/home/igna/seia-auth')
source = Path(__file__).resolve().parent
bun = Path('/home/igna/.local/share/hapi/build-tools/bun/bin/bun')
db = Path('/home/igna/.local/share/seia-auth/passkeys.sqlite')
env = root/'service.env'
hapi_env = root/'hapi-external-auth.env'
unit = Path.home()/'.config/systemd/user/seia-auth.service'
portal = Path('/home/igna/.local/share/remote-shell/nginx.conf')
editor = Path('/home/igna/editor-deployment/config.yaml')

if sys.argv[1:] != ['--bootstrap']:
    raise SystemExit('Usage: python3 deploy.py --bootstrap (first installation only)')
if any(path.exists() or path.is_symlink() for path in (env, hapi_env, unit)):
    raise SystemExit('Shared authentication is already configured. This script is only for the first installation.')
if not portal.is_file() or not editor.is_file():
    raise SystemExit('The existing portal and Editor configuration files are required.')
old_portal, old_editor = portal.read_text(), editor.read_text()
if 'location /auth/' in old_portal or 'location = /_seia_verify' in old_portal:
    raise SystemExit('The portal already contains shared authentication routes.')
for anchor in ('    location = /editor {', '    location /editor/ {', 'proxy_pass http://127.0.0.1:18081/;'):
    if old_portal.count(anchor) != 1:
        raise SystemExit('The portal does not have the expected legacy Editor routes.')
if not bun.is_file() or not os.access(bun, os.X_OK):
    raise SystemExit(f'Bun is missing or is not executable at {bun}.')
if not db.is_file():
    raise SystemExit('The shared Termix passkey database is required.')

with closing(sqlite3.connect(f'{db.as_uri()}?mode=ro', uri=True)) as sql:
    owners = sql.execute('SELECT DISTINCT userId FROM termix_credential_meta').fetchall()
    if len(owners) != 1:
        raise SystemExit('Explicit account selection required; no unique shared owner.')

    root.mkdir(exist_ok=True)
    if source != root:
        shutil.copytree(source, root, dirs_exist_ok=True, ignore=shutil.ignore_patterns('node_modules', 'backups', '__pycache__'))
    backup = root/'backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    with closing(sqlite3.connect(backup/'passkeys.sqlite')) as copy:
        sql.backup(copy)
    (backup/'passkeys.sqlite').chmod(0o600)

hapi_key = secrets.token_urlsafe(32)
env.write_text(f'SEIA_ORIGIN=https://seia.tailc9c975.ts.net\nSEIA_PASSKEY_DB={db}\nSEIA_USER_ID={owners[0][0]}\nSEIA_PORT=18082\nSEIA_HAPI_ORIGIN=https://seia.tailc9c975.ts.net:8444\nSEIA_HAPI_CLIENT_TOKEN={hapi_key}\n')
env.chmod(0o600)
# This file is supplied to the HAPI owner; no HAPI unit is changed here.
hapi_env.write_text(f'HAPI_EXTERNAL_AUTH_URL=http://127.0.0.1:18082\nHAPI_EXTERNAL_AUTH_LOGIN_URL=https://seia.tailc9c975.ts.net/auth/?app=hapi\nHAPI_EXTERNAL_AUTH_ORIGIN=https://seia.tailc9c975.ts.net:8444\nHAPI_EXTERNAL_AUTH_SUBJECT={owners[0][0]}\nHAPI_EXTERNAL_AUTH_TOKEN={hapi_key}\nHAPI_EXTERNAL_AUTH_NAMESPACE=default\n')
hapi_env.chmod(0o600)
admin = root/'passkey-admin.sh'
admin.write_text(f'#!/bin/bash\nset -eu\nset -a\nsource {env}\nset +a\nexec {bun} run {root}/admin.ts "$@"\n')
admin.chmod(0o700)
unit.write_text(f'''[Unit]
Description=Seia shared Passkey authentication
After=network.target
[Service]
Type=simple
WorkingDirectory={root}
EnvironmentFile={env}
ExecStart={bun} run {root}/server.ts
Restart=on-failure
RestartSec=3
UMask=0077
MemoryMax=256M
NoNewPrivileges=true
[Install]
WantedBy=default.target
''')
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','seia-auth.service'],check=True)
for _ in range(20):
    try:
        if json.load(urllib.request.urlopen('http://127.0.0.1:18082/health',timeout=2))['ok']: break
    except OSError: time.sleep(0.5)
else: raise RuntimeError('Auth service not ready; Editor remains unchanged')

shutil.copy2(portal,backup/'nginx.conf')
shutil.copy2(editor,backup/'editor-config.yaml')
auth = '''    # Shared Seia authentication. /_seia_verify cannot be called by a browser.
    location = /_seia_verify {
      internal;
      proxy_pass http://127.0.0.1:18082/verify;
      proxy_pass_request_body off;
      proxy_set_header Content-Length "";
      proxy_set_header Cookie $http_cookie;
      proxy_set_header Origin $http_origin;
      proxy_set_header X-Seia-Method $seia_original_method;
      proxy_set_header X-Seia-Upgrade $http_upgrade;
      proxy_connect_timeout 1s;
      proxy_read_timeout 4s;
    }
    location @seia_login {
      rewrite ^ /auth/start break;
      proxy_set_header X-Seia-Return $request_uri;
      proxy_pass http://127.0.0.1:18082;
    }
    location = /auth { return 302 /auth/; }
    location /auth/ {
      proxy_pass http://127.0.0.1:18082;
      proxy_set_header Host $http_host;
      proxy_set_header X-Seia-Return "";
      client_max_body_size 32k;
    }
'''
new_portal = old_portal.replace('    location = /editor {',auth+'    location = /editor {')
new_portal = new_portal.replace('    location /editor/ {','    location = /editor/logout { return 302 /auth/; }\n    location /editor/ {')
new_portal = new_portal.replace('      proxy_pass http://127.0.0.1:18081/;', '''      set $seia_original_method $request_method;
      auth_request /_seia_verify;
      error_page 401 = @seia_login;
      proxy_pass http://unix:/home/igna/editor-deployment/code-server.sock:/;''')
portal.write_text(new_portal)
nginx = ['/usr/sbin/nginx','-t','-p','/home/igna/.local/share/remote-shell/','-c',str(portal)]
try:
    subprocess.run(nginx,check=True)
    # The old nginx still targets port 18081 during the switch, so it fails closed.
    lines = [line for line in old_editor.splitlines() if not line.startswith(('auth:', 'password:', 'hashed-password:', 'socket:', 'socket-mode:', 'bind-addr:'))]
    editor.write_text('\n'.join(lines)+'\nauth: none\nsocket: /home/igna/editor-deployment/code-server.sock\nsocket-mode: "0600"\n')
    editor.chmod(0o600)
    subprocess.run(['systemctl','--user','restart','mobile-editor.service'],check=True)
    socket = Path('/home/igna/editor-deployment/code-server.sock')
    for _ in range(30):
        probe = subprocess.run(['curl','--silent','--fail','--max-time','2','--unix-socket',str(socket),'http://localhost/healthz'],capture_output=True)
        if probe.returncode == 0: break
        time.sleep(0.5)
    else: raise RuntimeError('Editor socket did not become ready')
    assert socket.stat().st_mode & 0o777 == 0o600
    subprocess.run(['systemctl','--user','reload','remote-portal.service'],check=True)
except Exception:
    portal.write_text(old_portal); editor.write_text(old_editor); editor.chmod(0o600)
    subprocess.run(['systemctl','--user','restart','mobile-editor.service'],check=True)
    subprocess.run(nginx,check=True)
    subprocess.run(['systemctl','--user','reload','remote-portal.service'],check=True)
    raise
print('Editor now uses shared Seia authentication; backup:',backup)
