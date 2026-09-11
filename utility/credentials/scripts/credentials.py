#!/usr/bin/python3
"""Audit and migrate ~/.bashrc credentials without printing their values."""

from __future__ import annotations

import argparse
import ctypes
import getpass
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
from datetime import datetime
from pathlib import Path


SECRET_NAME = re.compile(
    r"(?:^|_)(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|API_KEY|APIKEY|"
    r"ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|PAT|KEY)(?:_|$)"
)
NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
ASSIGNMENT = re.compile(
    r"^(?P<indent>[ \t]*)(?P<export>export[ \t]+)?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<rhs>.*?)"
    r"(?P<continuation>[ \t]+\\)?$"
)
COMMENTED_ASSIGNMENT = re.compile(
    r"^(?P<indent>[ \t]*)#[ \t]*(?P<body>export[ \t]+"
    r"[A-Za-z_][A-Za-z0-9_]*=.*)$"
)
START = "# >>> agent-workflow credentials >>>"
END = "# <<< agent-workflow credentials <<<"
KEYCHAIN_IF = "if command -v security >/dev/null 2>&1; then"
ERR_SEC_ITEM_NOT_FOUND = -25300


class KeychainFrameworkError(RuntimeError):
    def __init__(self, operation: str, status: int):
        super().__init__(f"{operation} failed with Security.framework status {status}")
        self.operation = operation
        self.status = status


def is_credential(name: str) -> bool:
    return bool(SECRET_NAME.search(name.upper()))


def validate_name(name: str) -> str:
    if not NAME.fullmatch(name) or not is_credential(name):
        raise SystemExit(
            "Credential name must be an uppercase shell identifier containing "
            "TOKEN, PASSWORD, PASSPHRASE, SECRET, API_KEY, ACCESS_KEY, "
            "PRIVATE_KEY, CREDENTIAL, AUTH, PAT, or KEY."
        )
    return name


def lookup(name: str) -> str:
    return (
        '"$(security find-generic-password -a "$USER" '
        f'-s "{name}" -w 2>/dev/null)"'
    )


def security_command() -> str:
    command = shutil.which("security")
    if command is None:
        raise SystemExit("macOS security command was not found in PATH.")
    return command


def keychain_has(name: str) -> bool:
    result = subprocess.run(
        [security_command(), "find-generic-password", "-a", account(), "-s", name, "-w"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def account() -> str:
    return os.environ.get("USER") or getpass.getuser()


def _system_security_command() -> bool:
    if sys.platform != "darwin":
        return False
    return Path(security_command()).resolve() == Path("/usr/bin/security")


def _load_keychain_framework():
    try:
        security = ctypes.CDLL(
            "/System/Library/Frameworks/Security.framework/Security"
        )
        core_foundation = ctypes.CDLL(
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        )
    except OSError as error:
        raise SystemExit(
            "Could not load macOS Security.framework for Keychain storage."
        ) from error

    void_p = ctypes.c_void_p
    uint32 = ctypes.c_uint32
    char_p = ctypes.c_char_p
    security.SecKeychainFindGenericPassword.argtypes = [
        void_p,
        uint32,
        char_p,
        uint32,
        char_p,
        ctypes.POINTER(uint32),
        ctypes.POINTER(void_p),
        ctypes.POINTER(void_p),
    ]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainAddGenericPassword.argtypes = [
        void_p,
        uint32,
        char_p,
        uint32,
        char_p,
        uint32,
        void_p,
        ctypes.POINTER(void_p),
    ]
    security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemModifyAttributesAndData.argtypes = [
        void_p,
        void_p,
        uint32,
        void_p,
    ]
    security.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
    core_foundation.CFRelease.argtypes = [void_p]
    core_foundation.CFRelease.restype = None
    return security, core_foundation


def _release_keychain_item(core_foundation, item_ref: ctypes.c_void_p) -> None:
    if item_ref.value:
        core_foundation.CFRelease(item_ref)


def _keychain_store_framework(name: str, value: str) -> None:
    # Security.framework receives the secret through a memory buffer, never
    # through argv or security's interactive readpassphrase path.
    security, core_foundation = _load_keychain_framework()
    service = name.encode("utf-8")
    user = account().encode("utf-8")
    password = value.encode("utf-8")
    password_buffer = ctypes.create_string_buffer(password)
    item_ref = ctypes.c_void_p()
    status = security.SecKeychainFindGenericPassword(
        None,
        len(service),
        service,
        len(user),
        user,
        None,
        None,
        ctypes.byref(item_ref),
    )

    if status == 0:
        try:
            status = security.SecKeychainItemModifyAttributesAndData(
                item_ref,
                None,
                len(password),
                ctypes.cast(password_buffer, ctypes.c_void_p),
            )
        finally:
            _release_keychain_item(core_foundation, item_ref)
        if status != 0:
            raise KeychainFrameworkError("updating Keychain item", status)
        return

    if status != ERR_SEC_ITEM_NOT_FOUND:
        raise KeychainFrameworkError("finding Keychain item", status)

    status = security.SecKeychainAddGenericPassword(
        None,
        len(service),
        service,
        len(user),
        user,
        len(password),
        ctypes.cast(password_buffer, ctypes.c_void_p),
        ctypes.byref(item_ref),
    )
    try:
        if status != 0:
            raise KeychainFrameworkError("adding Keychain item", status)
    finally:
        _release_keychain_item(core_foundation, item_ref)


def _keychain_store_cli(name: str, value: str) -> None:
    result = subprocess.run(
        [
            security_command(),
            "add-generic-password",
            "-U",
            "-a",
            account(),
            "-s",
            name,
            "-w",
        ],
        # With -w as the final option, macOS reads and confirms the value from
        # stdin instead of exposing it in the process argument list.
        input=value + "\n" + value + "\n",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or "unknown Keychain error"
        raise SystemExit(f"Could not store {name} in Keychain: {message}")


def keychain_store(name: str, value: str) -> None:
    if _system_security_command():
        try:
            _keychain_store_framework(name, value)
        except KeychainFrameworkError as error:
            raise SystemExit(f"Could not store {name} in Keychain: {error}") from error
        return
    _keychain_store_cli(name, value)


def parse_assignment(line: str):
    match = ASSIGNMENT.match(line)
    if not match or not is_credential(match.group("name")):
        return None
    return match


def parse_commented_assignment(line: str):
    commented = COMMENTED_ASSIGNMENT.match(line)
    if not commented:
        return None
    parsed = parse_assignment(commented.group("body"))
    if not parsed:
        return None
    return commented, parsed


def is_keychain_reference(name: str, rhs: str) -> bool:
    return (
        "security find-generic-password" in rhs
        and re.search(rf"-s[ \t]+(['\"]){re.escape(name)}\1", rhs) is not None
    )


def literal_value(rhs: str) -> str | None:
    candidate = rhs.strip()
    if not candidate or any(token in candidate for token in ("$", "`", "<(", ">(")):
        return None
    try:
        parts = shlex.split(candidate, posix=True)
    except ValueError:
        return None
    return parts[0] if len(parts) == 1 else None


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def inventory(lines: list[str]) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    in_managed = False
    for line in lines:
        if line == START:
            in_managed = True
            continue
        if line == END:
            in_managed = False
            continue
        commented = parse_commented_assignment(line)
        if commented:
            _, parsed = commented
            kind = "disabled-keychain" if is_keychain_reference(
                parsed.group("name"), parsed.group("rhs")
            ) else "disabled-literal"
            found.setdefault(parsed.group("name"), set()).add(kind)
            continue
        parsed = parse_assignment(line)
        if not parsed:
            continue
        kind = "keychain" if is_keychain_reference(
            parsed.group("name"), parsed.group("rhs")
        ) else "literal-or-dynamic"
        if in_managed:
            kind = "managed-keychain" if kind == "keychain" else kind
        found.setdefault(parsed.group("name"), set()).add(kind)
    return found


def audit(path: Path, requested: str | None) -> None:
    entries = inventory(read_lines(path))
    names = [validate_name(requested)] if requested else sorted(entries)
    if not names:
        print("No credential variables found in the bashrc file.")
        return
    for name in names:
        bashrc = ",".join(sorted(entries.get(name, {"missing"})))
        present = "present" if keychain_has(name) else "missing"
        print(f"{name}: bashrc={bashrc}; keychain={present}")


def managed_names(lines: list[str]) -> set[str]:
    names: set[str] = set()
    in_managed = False
    for line in lines:
        if line == START:
            in_managed = True
            continue
        if line == END:
            in_managed = False
            continue
        if in_managed:
            parsed = parse_assignment(line)
            if parsed:
                names.add(parsed.group("name"))
    return names


def remove_managed_block(lines: list[str]) -> tuple[list[str], int | None]:
    output: list[str] = []
    insertion: int | None = None
    in_managed = False
    for line in lines:
        if line == START:
            in_managed = True
            insertion = len(output) if insertion is None else insertion
            continue
        if in_managed:
            if line == END:
                in_managed = False
            continue
        output.append(line)
    if in_managed:
        raise SystemExit(f"Unclosed managed credential block in bashrc: missing '{END}'.")
    return output, insertion


def exact_wrapper(lines: list[str], index: int):
    if index + 2 >= len(lines) or lines[index].strip() != KEYCHAIN_IF:
        return None
    parsed = parse_assignment(lines[index + 1])
    if not parsed or lines[index + 2].strip() != "fi":
        return None
    name = parsed.group("name")
    if not is_keychain_reference(name, parsed.group("rhs")):
        return None
    return name


def rewrite(lines: list[str], selected: set[str]) -> list[str]:
    active_names = managed_names(lines)
    lines, insertion = remove_managed_block(lines)
    output: list[str] = []
    index = 0
    while index < len(lines):
        wrapped = exact_wrapper(lines, index)
        if wrapped:
            active_names.add(wrapped)
            insertion = len(output) if insertion is None else insertion
            index += 3
            continue

        line = lines[index]
        commented = parse_commented_assignment(line)
        if commented and commented[1].group("name") in selected:
            outer, parsed = commented
            name = parsed.group("name")
            line = f'{outer.group("indent")}# export {name}={lookup(name)}'
            output.append(line)
            index += 1
            continue

        parsed = parse_assignment(line)
        normalize_keychain_export = bool(
            parsed
            and parsed.group("export")
            and not parsed.group("indent")
            and is_keychain_reference(parsed.group("name"), parsed.group("rhs"))
        )
        if parsed and (parsed.group("name") in selected or normalize_keychain_export):
            name = parsed.group("name")
            if parsed.group("export") and not parsed.group("indent"):
                active_names.add(name)
                insertion = len(output) if insertion is None else insertion
            else:
                continuation = parsed.group("continuation") or ""
                export = parsed.group("export") or ""
                output.append(
                    f'{parsed.group("indent")}{export}{name}={lookup(name)}{continuation}'
                )
            index += 1
            continue

        output.append(line)
        index += 1

    active_names.update(name for name in selected if name not in inventory(lines))
    block = [START, KEYCHAIN_IF]
    block.extend(f"  export {name}={lookup(name)}" for name in sorted(active_names))
    block.extend(["fi", END])
    where = len(output) if insertion is None else insertion
    before = output[:where]
    after = output[where:]
    if before and before[-1] != "":
        before.append("")
    if after and after[0] != "":
        block.append("")
    return before + block + after


def sanitized_backup(lines: list[str]) -> list[str]:
    result: list[str] = []
    for line in lines:
        commented = parse_commented_assignment(line)
        if commented:
            outer, parsed = commented
            if not is_keychain_reference(parsed.group("name"), parsed.group("rhs")):
                line = (
                    f'{outer.group("indent")}# export '
                    f'{parsed.group("name")}="<redacted>"'
                )
            result.append(line)
            continue
        parsed = parse_assignment(line)
        if parsed and not is_keychain_reference(parsed.group("name"), parsed.group("rhs")):
            continuation = parsed.group("continuation") or ""
            export = parsed.group("export") or ""
            line = (
                f'{parsed.group("indent")}{export}{parsed.group("name")}='
                f'"<redacted>"{continuation}'
            )
        result.append(line)
    return result


def write_bashrc(path: Path, lines: list[str], original: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = path.with_name(f"{path.name}.credentials-backup-{stamp}")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    # Preserve structure while removing every credential value. Copying the
    # original literals would defeat the migration even if the active file
    # were safe.
    safe_backup = sanitized_backup(original)
    backup.write_text("\n".join(safe_backup).rstrip() + "\n", encoding="utf-8")
    backup.chmod(mode)
    temporary = path.with_name(f".{path.name}.credentials.tmp-{os.getpid()}")
    temporary.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)
    return backup


def store(path: Path, name: str, from_stdin: bool) -> None:
    name = validate_name(name)
    if from_stdin:
        value = sys.stdin.readline().rstrip("\n")
    else:
        value = getpass.getpass(f"Value for {name}: ")
    if not value:
        raise SystemExit("Credential value cannot be empty.")
    keychain_store(name, value)
    original = read_lines(path)
    backup = write_bashrc(path, rewrite(original, {name}), original)
    print(f"Stored {name} in Keychain and updated bashrc. Backup: {backup}")


def migration_candidates(lines: list[str]):
    candidates: dict[str, str] = {}
    unsupported: set[str] = set()
    for line in lines:
        parsed = parse_assignment(line)
        if not parsed:
            commented = parse_commented_assignment(line)
            parsed = commented[1] if commented else None
        if not parsed:
            continue
        name = parsed.group("name")
        rhs = parsed.group("rhs")
        if is_keychain_reference(name, rhs):
            continue
        value = literal_value(rhs)
        if value is None:
            unsupported.add(name)
        elif name in candidates and candidates[name] != value:
            candidates.pop(name)
            unsupported.add(name)
        elif name not in unsupported:
            candidates[name] = value
    return candidates, unsupported


def migrate(path: Path, apply: bool) -> None:
    lines = read_lines(path)
    candidates, unsupported = migration_candidates(lines)
    existing = {
        name
        for name, kinds in inventory(lines).items()
        if any("keychain" in kind for kind in kinds)
    }
    print("Credential variables eligible for migration:")
    for name in sorted(candidates):
        print(f"  {name}")
    if unsupported:
        print("Dynamic or unsupported entries requiring manual review:")
        for name in sorted(unsupported):
            print(f"  {name}")
    if not apply:
        print("Preview only. Run migrate --apply after explicit user authorization.")
        return
    for name, value in candidates.items():
        keychain_store(name, value)
    selected = set(candidates) | existing
    if not selected:
        print("Nothing to migrate.")
        return
    backup = write_bashrc(path, rewrite(lines, selected), lines)
    print(f"Migrated {len(candidates)} credential value(s). Backup: {backup}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--bashrc", type=Path, default=Path.home() / ".bashrc", help=argparse.SUPPRESS
    )
    commands = result.add_subparsers(dest="command", required=True)
    audit_parser = commands.add_parser("audit", help="report locations without values")
    audit_parser.add_argument("name", nargs="?")
    store_parser = commands.add_parser("store", help="store one requested credential")
    store_parser.add_argument("name")
    store_parser.add_argument("--stdin", action="store_true", help=argparse.SUPPRESS)
    migrate_parser = commands.add_parser("migrate", help="preview or migrate bashrc credentials")
    migrate_parser.add_argument("--apply", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "audit":
        audit(args.bashrc, args.name)
    elif args.command == "store":
        store(args.bashrc, args.name, args.stdin)
    else:
        migrate(args.bashrc, args.apply)


if __name__ == "__main__":
    main()
