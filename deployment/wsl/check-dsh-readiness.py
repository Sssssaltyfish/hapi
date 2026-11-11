"""Require 30 consecutive seconds of DSH HTTP readiness during startup."""

import time
import urllib.error
import urllib.request


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
deadline = time.monotonic() + 60
healthy_since = None
while time.monotonic() < deadline:
    try:
        with opener.open('http://127.0.0.1:3000/', timeout=2) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
    except (OSError, urllib.error.URLError):
        status = 0

    if status in (200, 401):
        now = time.monotonic()
        if healthy_since is None:
            healthy_since = now
        if now - healthy_since >= 30:
            break
    else:
        healthy_since = None
    time.sleep(1)
else:
    raise SystemExit('DSH did not remain ready for 30 seconds within the startup deadline.')
