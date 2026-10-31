"""Read UTF-8 text and report Han characters for review without rewriting it."""

import argparse
import json
from pathlib import Path
import sys
import unicodedata


def findings(text, path, allowed):
    masked = text
    for original in sorted(set(allowed), key=len, reverse=True):
        if original:
            replacement = "".join(char if char in "\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029"
                                  else " " for char in original)
            masked = masked.replace(original, replacement)
    result = []
    for line_number, line in enumerate(masked.splitlines(), 1):
        for column, char in enumerate(line, 1):
            name = unicodedata.name(char, "")
            if (name.startswith(("CJK UNIFIED IDEOGRAPH-", "CJK COMPATIBILITY IDEOGRAPH-"))
                    or char in "\u3005\u3007\u303b"):
                result.append({"path": path, "line": line_number, "column": column,
                               "codepoint": "U+{:04X}".format(ord(char))})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="UTF-8 files, or - for standard input")
    parser.add_argument("--allow-text", action="append", default=[],
                        help="Exact original text to preserve; no patterns or automatic exclusions")
    args = parser.parse_args()
    found, errors = [], []
    for path in args.paths:
        try:
            text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
            found.extend(findings(text, path, args.allow_text))
        except (OSError, UnicodeError) as error:
            errors.append({"path": path, "error": str(error)})
    status = "error" if errors else "review" if found else "clean"
    print(json.dumps({"status": status, "findings": found, "errors": errors}, ensure_ascii=True))
    return 2 if errors else 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
