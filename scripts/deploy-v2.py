#!/usr/bin/env python3
"""Deploy the PayPerCall v2 Worker (script name: paypercall-v2) WITH the
PURCHASES KV binding attached.

Why not cf-worker-deploy? That helper cannot set bindings. This script is
the same multipart script-upload it performs, plus worker metadata:

    bindings: [{type: "kv_namespace", name: "PURCHASES", namespace_id: ...}]

Auth uses the connector's stored credential via dynamic_credentials —
no token is read, printed, or stored here.

Usage:
    PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin \
      python3 scripts/deploy-v2.py [--bundle worker/dist/worker.js]
"""

import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API_BASE = "https://api.cloudflare.com/client/v4"
ALLOWED_HOSTS = ["api.cloudflare.com"]
CREDENTIAL = "custom.cloudflare"
ACCOUNT_ID = "c565502b520325c4b2763a6fcf4ccde1"
SCRIPT_NAME = "paypercall-v2"
KV_NAMESPACE_ID = "76cb305af42143e490df081d6e00d290"  # paypercall-v2-purchases
BOUNDARY = "----ppc2deployboundary9e1a"


def api(method, path, body=None, ctype=None):
    req = urllib.request.Request(API_BASE + path, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    add_surrogate_to_request(req, CREDENTIAL, entry_name="access_token",
                             allowed_hosts=ALLOWED_HOSTS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return read_json_response(resp)


def multipart(metadata, filename, script):
    b = BOUNDARY.encode()
    parts = [
        b"--" + b + b'\r\nContent-Disposition: form-data; name="metadata"\r\n'
        b"Content-Type: application/json\r\n\r\n" + json.dumps(metadata).encode() + b"\r\n",
        b"--" + b + b'\r\nContent-Disposition: form-data; name="script"; filename="'
        + filename.encode() + b'"\r\nContent-Type: application/javascript+module\r\n\r\n'
        + script + b"\r\n",
        b"--" + b + b"--\r\n",
    ]
    return b"".join(parts), f"multipart/form-data; boundary={BOUNDARY}"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_bundle = os.path.join(here, "..", "worker", "dist", "worker.js")
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=default_bundle)
    args = ap.parse_args()

    with open(args.bundle, "rb") as fh:
        script = fh.read()

    metadata = {
        "main_module": "worker.js",
        "bindings": [
            {"type": "kv_namespace", "name": "PURCHASES",
             "namespace_id": KV_NAMESPACE_ID}
        ],
    }
    body, ctype = multipart(metadata, "worker.js", script)
    data = api("PUT", f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}",
               body, ctype)
    if not data.get("success"):
        print(json.dumps(data, indent=2), file=sys.stderr)
        return 1

    sub = api("POST",
              f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/subdomain",
              b'{"enabled": true}', "application/json")
    url = None
    if sub.get("success"):
        acct = api("GET", f"/accounts/{ACCOUNT_ID}/workers/subdomain")
        sd = (acct.get("result") or {}).get("subdomain")
        if sd:
            url = f"https://{SCRIPT_NAME}.{sd}.workers.dev"
    print(json.dumps({"success": True, "script": SCRIPT_NAME, "url": url,
                      "kv_namespace_id": KV_NAMESPACE_ID}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
