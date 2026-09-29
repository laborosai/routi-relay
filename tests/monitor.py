"""Exercise the monitor against a local HTTP server; no external service calls."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/monitor.sh"


class MonitorTest(unittest.TestCase):
    def test_only_healthy_relay_and_disk_send_heartbeat(self):
        requests = []
        health = [200, b"ok"]

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(health[0] if self.path == "/health" else 200)
                self.end_headers()
                self.wfile.write(health[1])

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                df = Path(directory) / "df"
                df.write_text('#!/bin/sh\necho "disk 100 10 90 ${TEST_DISK_USED}% /data"\n')
                df.chmod(0o755)
                url = f"http://127.0.0.1:{server.server_port}"
                env = dict(os.environ, PATH=directory + ":" + os.environ["PATH"],
                           RELAY_HEALTH_URL=url + "/health", RELAY_HEARTBEAT_URL=url + "/ping")
                for status, body, disk, expected in [
                    (200, b"ok", "20", True), (503, b"down", "20", False),
                    (200, b"wrong service", "20", False), (200, b"ok", "90", False),
                ]:
                    with self.subTest(status=status, body=body, disk=disk):
                        requests.clear()
                        health[:] = [status, body]
                        result = subprocess.run(["bash", str(SCRIPT)],
                                                env=dict(env, TEST_DISK_USED=disk), capture_output=True)
                        self.assertEqual(result.returncode == 0, expected, result.stderr)
                        self.assertEqual("/ping" in requests, expected)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
