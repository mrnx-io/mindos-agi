#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]


def run(cmd, cwd=None):
    subprocess.run(cmd, check=True, cwd=cwd)


def git_root():
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
            cwd=ROOT_DIR,
        )
        return result.stdout.strip()
    except Exception:
        return None


def main():
    os.chdir(ROOT_DIR)
    run([sys.executable, str(ROOT_DIR / "bin/compile-system.py")])

    repo_root = git_root()
    if not repo_root:
        print("Check skipped git diff: not a git repo.")
        return

    diff = subprocess.run(
        ["git", "diff", "--exit-code", "--", "packages/brand-system"],
        cwd=repo_root,
    )
    if diff.returncode != 0:
        print("Brand system outputs out of sync. Commit regenerated files.")
        sys.exit(1)

    print("Brand system check passed.")


if __name__ == "__main__":
    main()
