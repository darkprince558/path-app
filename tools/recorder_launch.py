"""Launch the Mac pipeline and show pairing links on a loopback-only setup page."""

import argparse
import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
CERT_FILE = "Path-Recorder-CA.cer"


def mac_addresses():
    command = subprocess.run(
        ["scutil", "--get", "LocalHostName"],
        check=False,
        capture_output=True,
        text=True,
    )
    label = command.stdout.strip()
    if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label):
        raise ValueError(
            "Set the Mac's local hostname in System Settings > Sharing before pairing the phones."
        )
    route = subprocess.run(
        ["route", "-n", "get", "default"], check=False, capture_output=True, text=True
    )
    interface = re.search(r"^\s*interface:\s*(\w+)", route.stdout, re.MULTILINE)
    names = list(
        dict.fromkeys(
            (
                [interface[1]]
                if interface and re.fullmatch(r"en\d+", interface[1])
                else []
            )
            + ["en0", "en1"]
        )
    )
    for name in names:
        result = subprocess.run(
            ["ipconfig", "getifaddr", name], check=False, capture_output=True, text=True
        )
        try:
            ip = ipaddress.IPv4Address(result.stdout.strip())
        except ValueError:
            continue
        if ip.is_private and not ip.is_loopback and not ip.is_link_local:
            return label.lower() + ".local", str(ip)
    raise ValueError("Connect the Mac to the same local network as the phones.")


def local_identity(data, dns, ip):
    folder = data / "lan-tls"
    cert, key, root = folder / "server.pem", folder / "server.key", folder / CERT_FILE
    if folder.exists():
        manifest = json.loads((folder / "identity.json").read_text())
        if (
            manifest["dns"] != dns
            or subprocess.run(
                ["openssl", "x509", "-in", str(cert), "-noout", "-checkend", "86400"],
                check=False,
                capture_output=True,
            ).returncode
        ):
            raise ValueError(
                "The local HTTPS identity changed or expired. Move the lan-tls folder out of the data directory and restart to pair a new identity."
            )
        return cert, key, root, manifest["ip"] == ip
    # The signing key is ephemeral. Only the HTTPS leaf key stays on this Mac.
    with tempfile.TemporaryDirectory(dir=data) as tmp:
        work = Path(tmp)
        dest = work / "identity"
        dest.mkdir(mode=0o700)
        cfg = work / "openssl.cnf"
        cfg.write_text(f"""[req]
prompt=no
distinguished_name=dn
[dn]
CN=Path Recorder on {dns}
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign
subjectKeyIdentifier=hash
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:{dns},IP:{ip}
authorityKeyIdentifier=keyid
""")

        def ssl(*args):
            subprocess.run(
                ["openssl", *map(str, args)], cwd=work, check=True, capture_output=True
            )

        ssl(
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "180",
            "-sha256",
            "-subj",
            "/CN=Path Recorder Local CA",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
            "-config",
            cfg,
            "-extensions",
            "ca",
        )
        ssl(
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            dest / key.name,
            "-out",
            "leaf.csr",
            "-config",
            cfg,
        )
        ssl(
            "x509",
            "-req",
            "-in",
            "leaf.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "179",
            "-sha256",
            "-extfile",
            cfg,
            "-extensions",
            "leaf",
            "-out",
            dest / cert.name,
        )
        ssl("x509", "-in", "ca.pem", "-outform", "der", "-out", dest / root.name)
        (dest / "identity.json").write_text(json.dumps({"dns": dns, "ip": ip}))
        dest.rename(folder)
    return cert, key, root, True


def qr(url):
    binary = shutil.which("qrencode")
    if not binary:
        return ""
    image = subprocess.check_output(
        [binary, "-t", "PNG", "-s", "5", "-o", "-"], input=url.encode()
    )
    return (
        '<img alt="Scan this QR code with the phone camera" src="data:image/png;base64,'
        + base64.b64encode(image).decode()
        + '">'
    )


def setup_page(origin, token, certificate_url, certificate, ip_origin=None):
    def link(url, label):
        return f'<a rel="noreferrer" href="{html.escape(url, quote=True)}">{html.escape(label)}</a>'

    recorder = origin + "/record#key=" + quote(token, safe="")
    fallback = ""
    if ip_origin:
        alternative = ip_origin + "/record#key=" + quote(token, safe="")
        fallback = (
            "<details><summary>If the Mac’s name does not open</summary>"
            + qr(alternative)
            + "<p>Open "
            + link(alternative, "the recorder at its Wi-Fi address")
            + ". Links from this address work while the Mac keeps this IP.</p></details>"
        )
    digest = hashlib.sha256(certificate.read_bytes()).hexdigest().upper()
    fingerprint = " ".join(digest[n : n + 4] for n in range(0, len(digest), 4))
    trust = f"""<section><h2>Trust this Mac on each iPhone</h2>{qr(certificate_url)}
    <p>Join the same Wi-Fi. Scan the code in Camera or open {link(certificate_url, "the local certificate")} in Safari.
    In Settings, open <b>Profile Downloaded</b> and install the certificate.
    Compare the certificate’s SHA-256 fingerprint with the value below. Then turn on <b>Path Recorder Local CA</b> in Settings → General → About → Certificate Trust Settings.</p>
    <details><summary>Certificate fingerprint (SHA-256)</summary><code>{fingerprint}</code></details></section>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer"><title>Connect a phone · Path</title><style>
    :root{{font:16px/1.5 system-ui,sans-serif;color:#203028;background:#f4f5ee}}body{{margin:0}}main{{max-width:900px;margin:5vh auto;padding:0 24px}}
    h1{{font-size:clamp(2rem,5vw,3.2rem);letter-spacing:-.055em;line-height:1.05}}h2{{font-size:1.18rem}}.cards{{display:flex;flex-wrap:wrap;gap:16px}}
    section{{flex:1 1 250px;border:1px solid #c8d1c5;border-radius:14px;padding:18px;background:white}}img{{display:block;width:155px;max-width:100%}}
    a{{color:#186144}}code{{font-size:12px;overflow-wrap:anywhere}}footer{{margin-top:1rem}}
    </style></head><body><main><h1>Connect your phone to Path</h1><div class="cards">{trust}
    <section><h2>Record a hallway</h2>{qr(recorder)}<p>Scan with the organizer phone or {link(recorder, "open the recorder")}.
    This private link lets its holder record and process new takes on this Mac.</p>{fallback}</section></div>
    <footer>After processing, use <b>Share scan</b> or <b>Copy link</b> in the recorder. Open that guest link on the second phone.
    Keep both phones on this Wi-Fi and leave the Mac awake.</footer></main></body></html>""".encode()


def serve(host, port, path, get_bytes, kind, *, local=False):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if local and self.headers.get("Host") not in {
                f"localhost:{port}",
                f"127.0.0.1:{port}",
            }:
                self.send_error(403)
                return
            if self.path != path:
                self.send_error(404)
                return
            payload = get_bytes()
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run(args):
    os.umask(0o077)
    data = args.data.expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    dist = ROOT / "apps/web/dist"
    if not (dist / "index.html").is_file():
        raise ValueError(
            "Build the website first: cd apps/web && pnpm install --frozen-lockfile && pnpm build"
        )
    ports = (args.port, args.setup_port, args.certificate_port)
    if len(set(ports)) < 3 or any(not 1 <= p <= 65535 for p in ports):
        raise ValueError("Use three distinct TCP ports between 1 and 65535.")
    args.pipeline = args.pipeline.expanduser().resolve()
    if not args.pipeline.is_file() or not os.access(args.pipeline, os.X_OK):
        raise ValueError("The hallway3d executable could not be found.")
    cmd = [
        sys.executable,
        ROOT / "tools/recorder_server.py",
        "--data",
        data,
        "--dist",
        dist,
        "--pipeline",
        args.pipeline,
        "--port",
        str(args.port),
    ]
    dns, ip = mac_addresses()
    cert, key, cert_file, ip_valid = local_identity(data, dns, ip)
    origin = f"https://{dns}:{args.port}"
    ip_origin = f"https://{ip}:{args.port}" if ip_valid else None
    cert_url = f"http://{ip}:{args.certificate_port}/{CERT_FILE}"
    cmd.extend(["--host", ip, "--cert", cert, "--key", key])
    trust = ssl.create_default_context(cadata=cert_file.read_bytes())
    with ExitStack() as services:
        services.enter_context(
            serve(
                ip,
                args.certificate_port,
                "/" + CERT_FILE,
                cert_file.read_bytes,
                "application/x-x509-ca-cert",
            )
        )
        proc = subprocess.Popen(cmd, start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            while True:
                if proc.poll() is not None:
                    return proc.returncode or 1
                if (data / "organizer.key").is_file():
                    try:
                        with (
                            socket.create_connection(
                                (ip, args.port), timeout=0.5
                            ) as conn,
                            trust.wrap_socket(conn, server_hostname=dns),
                        ):
                            break
                    except OSError:
                        pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Recorder service did not start.")
                time.sleep(0.1)
            page = setup_page(
                origin,
                (data / "organizer.key").read_text().strip(),
                cert_url,
                cert_file,
                ip_origin,
            )
            services.enter_context(
                serve(
                    "127.0.0.1",
                    args.setup_port,
                    "/",
                    lambda: page,
                    "text/html; charset=utf-8",
                    local=True,
                )
            )
            print(
                f"Open http://127.0.0.1:{args.setup_port}/ on the Mac to pair a phone. Guest origin: {origin}",
                flush=True,
            )
            return proc.wait()
        finally:
            stop_worker_group(proc)


def stop_worker_group(proc):
    # Native FFmpeg and OpenMVS children inherit this private process group.
    # Allow them to stop before another launcher recovers the processing queue.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        proc.wait()
        return
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # The server can exit first while a native child still holds the group.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data", type=Path, default=ROOT / "captures-local/phone-recorder"
    )
    parser.add_argument("--pipeline", type=Path, default=ROOT / "hallway3d")
    parser.add_argument("--port", type=int, default=8643)
    parser.add_argument("--setup-port", type=int, default=8644)
    parser.add_argument("--certificate-port", type=int, default=8645)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        sys.exit(run(parser.parse_args()))
    except KeyboardInterrupt:
        pass
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"{exc}\n")
