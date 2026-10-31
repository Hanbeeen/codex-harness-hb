import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PersonalKoreanInstallTests(unittest.TestCase):
    def test_real_install_function_embeds_policy_and_preserves_repeat_result(self):
        bash = shutil.which("bash")
        git_bash = Path("C:/Program Files/Git/bin/bash.exe")
        if git_bash.is_file():
            bash = str(git_bash)
        self.assertIsNotNone(bash, "개인용 셸 설치 검증에 bash가 필요함")
        definitions = (ROOT / "install.sh").read_text(encoding="utf-8").rsplit('\nmain "$@"', 1)[0]
        with tempfile.TemporaryDirectory(prefix="personal-korean-") as folder:
            base = Path(folder)
            work = base / "work"
            work.mkdir()
            script = base / "verify.sh"
            script.write_text(definitions + '''
CODEX_DIR=$TASK_TEST_HOME
H=$CODEX_DIR/harness
STATE=$H/state
INST=$H/installed
BACKUP_DIR=$H/backup/test
SRC_ROOT=$TASK_TEST_SOURCE
WORK=$TASK_TEST_WORK
NAME=Hanbin
: > "$WORK/done"
: > "$WORK/same"
: > "$WORK/skip"
: > "$WORK/note"
install_agents_md
''', encoding="utf-8")
            env = dict(os.environ, TASK_TEST_HOME=(base / "codex").as_posix(),
                       TASK_TEST_SOURCE=ROOT.as_posix(), TASK_TEST_WORK=work.as_posix())
            command = [bash, "--noprofile", "--norc", script.as_posix()]
            result = subprocess.run(command, env=env, capture_output=True, text=True,
                                    encoding="utf-8", timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            installed = base / "codex/AGENTS.md"
            before = installed.read_bytes()
            policy = (ROOT / "contest-kit/korean-output.md").read_bytes().replace(b"\r\n", b"\n")
            self.assertTrue(policy in before.replace(b"\r\n", b"\n"),
                            "개인용 설치 결과에 한국어 정책 본문이 없음")
            checker = base / "codex/harness/tools/check_korean_output.py"
            self.assertEqual(checker.read_bytes(), (ROOT / "contest-kit/tools/check_korean_output.py").read_bytes())
            timestamp = installed.stat().st_mtime_ns
            result = subprocess.run(command, env=env, capture_output=True, text=True,
                                    encoding="utf-8", timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(installed.read_bytes(), before)
            self.assertEqual(installed.stat().st_mtime_ns, timestamp)
            kept = checker.parent / "keep.txt"
            kept.write_bytes(b"personal file\n")
            definitions = (ROOT / "uninstall.sh").read_text(encoding="utf-8").rsplit('\nmain "$@"', 1)[0]
            script.write_text(definitions + '''
H=$TASK_TEST_HOME/harness
STATE=$H/state
WORK=$TASK_TEST_WORK
: > "$WORK/done"
remove_owned
''', encoding="utf-8")
            result = subprocess.run(command, env=env, capture_output=True, text=True,
                                    encoding="utf-8", timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(checker.exists(), "개인용 제거 후 검사기가 남아 있음")
            self.assertEqual(kept.read_bytes(), b"personal file\n")


if __name__ == "__main__":
    unittest.main()
