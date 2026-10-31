import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "contest-kit/tools/check_korean_output.py"


class KoreanOutputTests(unittest.TestCase):
    def check_text(self, text, *options):
        self.assertTrue(CHECKER.is_file(), "문자 검사기가 아직 없음")
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(CHECKER), *options, "-"],
            input=text, capture_output=True, text=True, encoding="utf-8", timeout=10,
        )

    def test_korean_english_and_empty_text_are_clean(self):
        for text in ("", "검증 결과 API 응답을 확인했습니다.\nUTF-8과 Python을 사용합니다."):
            with self.subTest(text=text):
                result = self.check_text(text)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["findings"], [])

    def test_detects_mixed_han_at_exact_line_and_column(self):
        result = self.check_text("정상입니다.\n처리 \u5b8c\u4e86\n")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["findings"], [
            {"path": "-", "line": 2, "column": 4, "codepoint": "U+5B8C"},
            {"path": "-", "line": 2, "column": 5, "codepoint": "U+4E86"},
        ])

    def test_supplementary_and_compatibility_ideographs_are_detected(self):
        result = self.check_text("\U00020000\uf900")
        self.assertEqual(result.returncode, 1)
        self.assertEqual([item["codepoint"] for item in json.loads(result.stdout)["findings"]],
                         ["U+20000", "U+F900"])

    def test_code_fences_do_not_hide_new_comments(self):
        result = self.check_text("```python\n# 처리 \u5b8c\u4e86\n```\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["findings"][0]["line"], 2)

    def test_explicit_original_does_not_hide_adjacent_new_han(self):
        result = self.check_text("원문: \u539f\u6587, 설명 \u5b8c\n", "--allow-text", "\u539f\u6587")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["findings"], [
            {"path": "-", "line": 1, "column": 12, "codepoint": "U+5B8C"},
        ])

    def test_explicit_original_is_preserved(self):
        result = self.check_text("원문: \u539f\u6587\n", "--allow-text", "\u539f\u6587")
        self.assertEqual(result.returncode, 0)

    def test_allowed_original_preserves_unicode_line_boundaries(self):
        result = self.check_text("원문: \u539f\u2028\u6587 설명 \u5b8c", "--allow-text", "\u539f\u2028\u6587")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["findings"], [
            {"path": "-", "line": 2, "column": 6, "codepoint": "U+5B8C"},
        ])

    def test_file_input_is_not_modified(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "한국어 주석.txt"
            original = "한글 \u6f22\r\n".encode("utf-8-sig")
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, "-X", "utf8", "-B", str(CHECKER), str(path)],
                capture_output=True, text=True, encoding="utf-8", timeout=10,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(json.loads(result.stdout)["findings"][0]["column"], 4)

    def test_read_errors_are_distinct_from_findings(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "missing.txt"
            result = subprocess.run(
                [sys.executable, "-X", "utf8", "-B", str(CHECKER), str(path)],
                capture_output=True, text=True, encoding="utf-8", timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["status"], "error")


if __name__ == "__main__":
    unittest.main()
