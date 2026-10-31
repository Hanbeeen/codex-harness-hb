"""Install reviewed project instructions without changing managed settings."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile


START = "<!-- codex-harness-contest:start -->"
END = "<!-- codex-harness-contest:end -->"
BLOCK = (
    START + "\n## 대회용 협업 지침\n\n"
    "- 실제 과제 안내와 제공 프로젝트의 필수 조건을 우선함.\n"
    "- .codex-harness/AGENTS.md를 읽어 적용하고 필요한 역할/요청문만 선택함.\n"
    "- git push와 다른 도구를 통한 원격 쓰기, Computer Use와 시험 자료의 외부 전송을 금지함.\n"
    "- 제공 Codex의 버전, 인증, 모델 제공자, 권한과 플랫폼 관리 설정을 보존함.\n"
    + END + "\n"
).encode("utf-8")


def guard_path(root, path):
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("linked path is not allowed: " + path.relative_to(root).as_posix())


def read_assets(source):
    manifest = json.loads((source / "assets.json").read_text(encoding="utf-8-sig"))
    files = manifest.get("files")
    if manifest.get("version") != 1 or not isinstance(files, dict) or not 1 <= len(files) <= 64:
        raise ValueError("invalid asset manifest")
    if not {"AGENTS.md", "README.md", "prompts/start-task.md", "korean-output.md",
            "tools/check_korean_output.py"} <= files.keys():
        raise ValueError("required assets missing from manifest")
    result = {}
    for name, expected in files.items():
        path = PurePosixPath(name)
        if (not name or path.as_posix() != name or "\\" in name or ":" in name or path.is_absolute()
                or ".." in path.parts
                or (path.suffix not in {".md", ".toml"} and name != "tools/check_korean_output.py")):
            raise ValueError("invalid asset path")
        asset = source.joinpath(*path.parts)
        guard_path(source, asset)
        data = asset.read_bytes().replace(b"\r\n", b"\n")
        data.decode("utf-8-sig")
        if len(data) > 131072 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("asset hash mismatch: " + name)
        result[name] = data
    return result


def install(project, source, agents=False, dry_run=False):
    project = project.resolve(strict=True)
    source = source.resolve(strict=True)
    home = Path.home().resolve()
    protected = [home / ".codex", home / ".agents",
                 Path(os.environ.get("CODEX_HOME") or home / ".codex").resolve()]
    if (not project.is_dir() or project == Path(project.anchor)
            or project == home or project in source.parents
            or project == source or source.parent in project.parents
            or any(project == path or path in project.parents for path in protected)):
        raise ValueError("project must be a separate provided project directory")
    assets = read_assets(source)
    block = BLOCK.replace(END.encode(), assets["korean-output.md"].rstrip() + b"\n\n" + END.encode())
    pending, unchanged = [], []

    def queue(path, data):
        guard_path(project, path)
        if any(path == location or location in path.parents for location in protected):
            raise ValueError("protected configuration path")
        if path.exists():
            if not path.is_file() or path.read_bytes() != data:
                raise ValueError("file conflict: " + path.relative_to(project).as_posix())
            unchanged.append(path)
        else:
            pending.append((path, data))

    for name, data in assets.items():
        queue(project / ".codex-harness" / name, data)
        if agents and name.startswith(".codex/agents/"):
            queue(project / name, data)

    instructions = project / "AGENTS.md"
    guard_path(project, instructions)
    previous = instructions.read_bytes() if instructions.exists() else None
    replacement = None
    if previous is None:
        queue(instructions, "# 프로젝트 협업 지침\n\n".encode("utf-8") + block)
    else:
        previous.decode("utf-8-sig")
        normalized = previous.replace(b"\r\n", b"\n")
        has_marker = START.encode() in normalized or END.encode() in normalized
        if has_marker:
            if (normalized.count(START.encode()) != 1 or normalized.count(END.encode()) != 1
                    or block not in normalized):
                raise ValueError("instruction block conflict")
            unchanged.append(instructions)
        else:
            queue(project / ".codex-harness/AGENTS.original.md", previous)
            newline = b"\r\n" if b"\r\n" in previous else b"\n"
            separator = newline if previous.endswith(b"\n") else newline * 2
            replacement = previous + separator + block.replace(b"\n", newline)

    paths = [path.relative_to(project).as_posix() for path, _ in pending]
    updated = ["AGENTS.md"] if replacement is not None else []
    result = {"status": "dry-run" if dry_run else "installed", "created": paths,
              "updated": updated, "unchanged": len(unchanged), "agentsEnabled": agents}
    if dry_run:
        return result
    for path, data in pending:
        guard_path(project, path)
        path.parent.mkdir(parents=True, exist_ok=True)
        guard_path(project, path)
        with path.open("xb") as output:
            output.write(data)
    if replacement is not None:
        guard_path(project, instructions)
        if instructions.read_bytes() != previous:
            raise ValueError("instruction conflict: file changed during install")
        mode = stat.S_IMODE(instructions.stat().st_mode)
        descriptor, name = tempfile.mkstemp(prefix=".codex-harness-agents-", dir=project)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(replacement)
            temporary.chmod(mode)
            os.replace(temporary, instructions)
        finally:
            if temporary.exists():
                temporary.unlink()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--agents", action="store_true", help="Only after confirming native role support")
    args = parser.parse_args()
    try:
        result = install(args.project, Path(__file__).parent, args.agents, args.dry_run)
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
