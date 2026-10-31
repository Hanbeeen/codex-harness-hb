import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


KIT = Path(__file__).resolve().parents[1] / "contest-kit"


class ContestInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="contest-install-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "provided project"
        self.project.mkdir()
        self.home = self.base / "home"
        (self.home / ".codex").mkdir(parents=True)
        (self.home / ".codex/config.toml").write_bytes(b"global-sentinel\n")
        (self.project / ".codex").mkdir()
        (self.project / ".codex/config.toml").write_bytes(b"provided-sentinel\n")

    def snapshot(self, folder=None):
        folder = folder or self.project
        return {p.relative_to(folder).as_posix(): p.read_bytes()
                for p in folder.rglob("*") if p.is_file()}

    def run_install(self, *options, source=KIT, codex_home=None):
        env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home),
                   PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
        if codex_home is not None:
            env["CODEX_HOME"] = str(codex_home)
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(source / "install.py"),
             "--project", str(self.project), *options],
            cwd=self.project, env=env, capture_output=True, text=True,
            encoding="utf-8", timeout=20,
        )

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def source_copy(self):
        result = self.base / "downloaded/contest-kit"
        shutil.copytree(KIT, result)
        return result

    def make_directory_link(self, link, target):
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)

    def test_install_preserves_existing_instructions_and_managed_settings(self):
        original = b"# Provided instructions\r\nKeep the original rules.\r\n"
        (self.project / "AGENTS.md").write_bytes(original)
        info = self.success(self.run_install())
        self.assertEqual(info["status"], "installed")
        self.assertTrue((self.project / "AGENTS.md").read_bytes().startswith(original))
        self.assertEqual((self.project / ".codex-harness/AGENTS.original.md").read_bytes(), original)
        self.assertTrue((self.project / ".codex-harness/roles/qa-ui.md").is_file())
        self.assertEqual((self.project / ".codex/config.toml").read_bytes(), b"provided-sentinel\n")
        self.assertEqual((self.home / ".codex/config.toml").read_bytes(), b"global-sentinel\n")
        self.assertFalse((self.project / ".codex/agents").exists())

    def test_dry_run_changes_nothing(self):
        before = self.snapshot()
        info = self.success(self.run_install("--dry-run"))
        self.assertEqual(info["status"], "dry-run")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.project / ".codex-harness").exists())

    def test_installed_root_includes_policy_and_checker_runs(self):
        self.success(self.run_install())
        policy = KIT / "korean-output.md"
        self.assertTrue(policy.is_file(), "공통 한국어 정책이 아직 없음")
        self.assertIn(policy.read_bytes().replace(b"\r\n", b"\n"),
                      (self.project / "AGENTS.md").read_bytes().replace(b"\r\n", b"\n"))
        checker = self.project / ".codex-harness/tools/check_korean_output.py"
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(checker), "-"],
            input="처리 \u5b8c\u4e86", capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(json.loads(result.stdout)["findings"]), 2)

    def test_unreviewed_python_asset_is_rejected_before_writes(self):
        source = self.source_copy()
        (source / "unexpected.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
        path = source / "assets.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["files"]["unexpected.py"] = hashlib.sha256(b"raise SystemExit(0)\n").hexdigest()
        path.write_text(json.dumps(manifest), encoding="utf-8")
        before = self.snapshot()
        result = self.run_install(source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("path", json.loads(result.stdout)["error"])
        self.assertEqual(self.snapshot(), before)

    def test_second_install_is_idempotent(self):
        self.success(self.run_install())
        before = self.snapshot()
        info = self.success(self.run_install())
        self.assertEqual(info["created"], [])
        self.assertEqual(self.snapshot(), before)

    def test_modified_installed_asset_blocks_all_writes(self):
        self.success(self.run_install())
        (self.project / ".codex-harness/AGENTS.md").write_bytes(b"local edits\n")
        before = self.snapshot()
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict", json.loads(result.stdout)["error"].lower())
        self.assertEqual(self.snapshot(), before)

    def test_native_agents_are_explicitly_opt_in(self):
        self.success(self.run_install("--agents"))
        target = self.project / ".codex/agents/qa-ui.toml"
        self.assertEqual(target.read_bytes(), (KIT / ".codex/agents/qa-ui.toml").read_bytes().replace(b"\r\n", b"\n"))

    def test_conflicting_native_agent_leaves_project_unchanged(self):
        folder = self.project / ".codex/agents"
        folder.mkdir()
        (folder / "qa-ui.toml").write_bytes(b"provided role\n")
        before = self.snapshot()
        result = self.run_install("--agents")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict", json.loads(result.stdout)["error"].lower())
        self.assertEqual(self.snapshot(), before)

    def test_linked_destination_cannot_write_outside_project(self):
        outside = self.base / "outside"
        outside.mkdir()
        marker = outside / "sentinel"
        marker.write_bytes(b"untouched")
        self.make_directory_link(self.project / ".codex-harness", outside)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("link", json.loads(result.stdout)["error"].lower())
        self.assertEqual(list(outside.iterdir()), [marker])
        self.assertEqual(marker.read_bytes(), b"untouched")
        self.assertFalse((self.project / "AGENTS.md").exists())

    def test_tampered_source_is_rejected_before_writes(self):
        source = self.source_copy()
        (source / "AGENTS.md").write_bytes(b"unexpected content\n")
        before = self.snapshot()
        result = self.run_install(source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hash", json.loads(result.stdout)["error"].lower())
        self.assertEqual(self.snapshot(), before)

    def test_manifest_path_traversal_is_rejected(self):
        source = self.source_copy()
        p = source / "assets.json"
        data = json.loads(p.read_text(encoding="utf-8"))
        data["files"]["../escape.md"] = hashlib.sha256(b"escape").hexdigest()
        p.write_text(json.dumps(data), encoding="utf-8")
        before = self.snapshot()
        result = self.run_install(source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("path", json.loads(result.stdout)["error"].lower())
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.base / "escape.md").exists())

    def test_unlisted_source_files_are_never_copied(self):
        source = self.source_copy()
        (source / "private").mkdir()
        (source / "private/notes.txt").write_bytes(b"not for installation")
        self.success(self.run_install(source=source))
        self.assertFalse((self.project / ".codex-harness/private").exists())
        self.assertFalse((self.project / ".codex-harness/install.py").exists())
        self.assertFalse((self.project / ".codex-harness/.git").exists())

    def test_aliased_manifest_path_is_rejected_before_writes(self):
        source = self.source_copy()
        p = source / "assets.json"
        data = json.loads(p.read_text(encoding="utf-8"))
        data["files"]["./AGENTS.md"] = data["files"]["AGENTS.md"]
        p.write_text(json.dumps(data), encoding="utf-8")
        before = self.snapshot()
        result = self.run_install(source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)

    def test_home_directory_is_not_a_project_target(self):
        before = self.snapshot(self.home)
        result = self.run_install("--project", str(self.home))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("project", json.loads(result.stdout)["error"])
        self.assertEqual(self.snapshot(self.home), before)

    def test_source_repository_is_not_a_project_target(self):
        source = self.source_copy()
        before = self.snapshot(self.base)
        result = self.run_install("--project", str(source.parent), source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("project", json.loads(result.stdout)["error"])
        self.assertEqual(self.snapshot(self.base), before)

    def test_personal_codex_directory_is_not_a_project_target(self):
        target = self.home / ".codex"
        before = self.snapshot(self.home)
        result = self.run_install("--project", str(target))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(self.home), before)

    def test_custom_codex_home_is_not_a_project_target(self):
        target = self.base / "custom-codex-home"
        target.mkdir()
        (target / "config.toml").write_bytes(b"managed configuration\n")
        before = self.snapshot(target)
        result = self.run_install("--project", str(target), codex_home=target)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(target), before)

    def test_source_repository_child_is_not_a_project_target(self):
        source = self.source_copy()
        target = source.parent / "tests"
        target.mkdir()
        before = self.snapshot(source.parent)
        result = self.run_install("--project", str(target), source=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(source.parent), before)

    def test_incomplete_managed_block_is_not_overwritten(self):
        (self.project / "AGENTS.md").write_bytes(b"<!-- codex-harness-contest:start -->\nlocal edit\n")
        before = self.snapshot()
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict", json.loads(result.stdout)["error"].lower())
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
