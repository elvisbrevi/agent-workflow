#!/usr/bin/python3
"""Audit, store and migrate credentials kept in chezmoi-managed env files.

Credential values never leave the process: they are read with a hidden prompt
(or stdin), written to ``<secrets>/<service>.env`` with 0600 permissions, and
encrypted at rest by chezmoi.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
from pathlib import Path

SECRET_NAME = re.compile(
    r"(?:^|_)(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|API_KEY|APIKEY|"
    r"ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|PAT|KEY)(?:_|$)"
)
NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
SERVICE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ASSIGNMENT = re.compile(
    r"^(?P<export>export[ \t]+)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<rhs>.*)$"
)

DEFAULT_SERVICE = "other"


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


def validate_service(service: str) -> str:
    stem = service[:-4] if service.endswith(".env") else service
    if not SERVICE.fullmatch(stem):
        raise SystemExit(
            "Service name must be lowercase and contain only [a-z0-9._-]."
        )
    return stem


def account() -> str:
    return os.environ.get("USER") or getpass.getuser()


def security_command() -> str | None:
    return shutil.which("security")


def keychain_available() -> bool:
    return security_command() is not None


def keychain_has(name: str) -> bool:
    command = security_command()
    if command is None:
        return False
    result = subprocess.run(
        [command, "find-generic-password", "-a", account(), "-s", name, "-w"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def keychain_get(name: str) -> str | None:
    command = security_command()
    if command is None:
        return None
    result = subprocess.run(
        [command, "find-generic-password", "-a", account(), "-s", name, "-w"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\n")


def assignment_name(line: str) -> str | None:
    if line.lstrip().startswith("#"):
        return None
    match = ASSIGNMENT.match(line)
    if not match or not is_credential(match.group("name")):
        return None
    return match.group("name")


def env_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(directory.glob("*.env"))


def file_has(name: str, path: Path) -> bool:
    return any(assignment_name(line) == name for line in read_lines(path))


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def write_env_file(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def upsert(path: Path, name: str, value: str) -> None:
    lines = read_lines(path)
    if not lines:
        lines = [
            f"# {path.name} - managed by chezmoi; load with: load-env {path.stem}",
            "",
        ]
    output: list[str] = []
    replaced = False
    for line in lines:
        if not line.lstrip().startswith("#") and ASSIGNMENT.match(line):
            if ASSIGNMENT.match(line).group("name") == name:
                if not replaced:
                    output.append(f"export {name}={shlex.quote(value)}")
                    replaced = True
                continue
        output.append(line)
    if not replaced:
        if output and output[-1].strip() != "":
            output.append("")
        output.append(f"export {name}={shlex.quote(value)}")
    write_env_file(path, output)


def chezmoi_readd(path: Path) -> bool:
    command = shutil.which("chezmoi")
    if command is None:
        return False
    check = subprocess.run(
        [command, "source-path", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if check.returncode != 0:
        return False
    result = subprocess.run(
        [command, "re-add", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def announce(path: Path) -> None:
    if chezmoi_readd(path):
        print(
            "Encrypted source updated. Publish with: "
            "chezmoi cd && git add -A && git commit && git push"
        )
    else:
        print("chezmoi did not manage that file; update the source state manually if needed.")


def target_for(directory: Path, name: str, service: str | None) -> Path:
    matches = [path for path in env_files(directory) if file_has(name, path)]
    if len(matches) > 1:
        names = ", ".join(path.name for path in matches)
        raise SystemExit(f"{name} is present in multiple files ({names}); pass --service.")
    if matches:
        return matches[0]
    if service:
        return directory / f"{validate_service(service)}.env"
    return directory / f"{DEFAULT_SERVICE}.env"


def audit(directory: Path, requested: str | None) -> None:
    entries: dict[str, set[str]] = {}
    for path in env_files(directory):
        for line in read_lines(path):
            name = assignment_name(line)
            if name:
                entries.setdefault(name, set()).add(path.name)
    names = [validate_name(requested)] if requested else sorted(entries)
    if not names:
        print(f"No credential variables found in {directory}.")
        return
    for name in names:
        where = ",".join(sorted(entries.get(name, []))) or "missing"
        if keychain_available():
            keychain = "present" if keychain_has(name) else "missing"
        else:
            keychain = "n/a"
        print(f"{name}: secrets={where}; keychain={keychain}")


def read_value(name: str, from_stdin: bool) -> str:
    if from_stdin:
        value = sys.stdin.readline().rstrip("\n")
    else:
        value = getpass.getpass(f"Value for {name}: ")
    if not value:
        raise SystemExit("Credential value cannot be empty.")
    if "\n" in value or "\r" in value:
        raise SystemExit("Credential value must be a single line.")
    return value


def store(directory: Path, name: str, service: str | None, from_stdin: bool) -> None:
    name = validate_name(name)
    value = read_value(name, from_stdin)
    target = target_for(directory, name, service)
    upsert(target, name, value)
    print(f"Stored {name} in {target}")
    announce(target)


def migrate(directory: Path, name: str, service: str | None) -> None:
    name = validate_name(name)
    if not keychain_available():
        raise SystemExit(
            "Keychain is only available where the security command exists (macOS); use store."
        )
    value = keychain_get(name)
    if value is None:
        raise SystemExit(f"{name} was not found in Keychain.")
    if not value:
        raise SystemExit("Keychain value is empty.")
    target = target_for(directory, name, service)
    upsert(target, name, value)
    print(f"Migrated {name} from Keychain to {target}")
    announce(target)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--secrets-dir",
        type=Path,
        default=Path.home() / ".config/secrets",
        help=argparse.SUPPRESS,
    )
    commands = result.add_subparsers(dest="command", required=True)
    audit_parser = commands.add_parser("audit", help="report where a credential lives, without values")
    audit_parser.add_argument("name", nargs="?")
    store_parser = commands.add_parser("store", help="store one requested credential in its env file")
    store_parser.add_argument("name")
    store_parser.add_argument("--service")
    store_parser.add_argument("--stdin", action="store_true", help=argparse.SUPPRESS)
    migrate_parser = commands.add_parser(
        "migrate", help="move a legacy macOS Keychain item into its env file"
    )
    migrate_parser.add_argument("name")
    migrate_parser.add_argument("--service")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "audit":
        audit(args.secrets_dir, args.name)
    elif args.command == "store":
        store(args.secrets_dir, args.name, args.service, args.stdin)
    else:
        migrate(args.secrets_dir, args.name, args.service)


if __name__ == "__main__":
    main()
