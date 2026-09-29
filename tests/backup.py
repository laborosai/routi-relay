"""Run with python3 tests/backup.py; requires sqlite3 and restic on PATH."""
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/backup.sh"


class BackupTest(unittest.TestCase):
    def test_restore_includes_committed_wal_but_not_uncommitted_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = dict(PATH=os.environ["PATH"], HOME=directory, RESTIC_REPOSITORY=str(root / "repo"),
                       RESTIC_PASSWORD="test-only", RELAY_DATABASE=str(root / "relay.db"))
            def run(*args):
                return subprocess.run(args, env=env, check=True, capture_output=True, text=True)

            run("restic", "init")
            with sqlite3.connect(env["RELAY_DATABASE"]) as source:
                source.execute("PRAGMA journal_mode=WAL")
                source.execute("CREATE TABLE devices (id TEXT PRIMARY KEY)")
                source.execute("INSERT INTO devices VALUES ('paired-phone')")
                source.commit()
                source.execute("INSERT INTO devices VALUES ('uncommitted-phone')")
                self.assertTrue(Path(env["RELAY_DATABASE"] + "-wal").exists())
                run("bash", str(SCRIPT))
                run("restic", "restore", "latest", "--target", str(root / "restore"))
                with sqlite3.connect(root / "restore/relay.db") as restored:
                    self.assertEqual(restored.execute("SELECT id FROM devices").fetchall(),
                                     [("paired-phone",)])
                self.assertEqual(source.execute("SELECT count(*) FROM devices").fetchone(), (2,))
                source.rollback()
            env["RELAY_DATABASE"] = str(root / "missing.db")
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(Path(env["RELAY_DATABASE"]).exists())


if __name__ == "__main__":
    unittest.main()
