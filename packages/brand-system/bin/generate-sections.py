#!/usr/bin/env python3
import json
import os
from glob import glob
from pathlib import Path

from section_utils import HEADING_RE, compute_section_id, get_anchor_id, is_anchor_line

ROOT_DIR = Path(__file__).resolve().parents[1]


def load_existing_order(registry_path):
    if not os.path.exists(registry_path):
        return []
    try:
        with open(registry_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []
    order = []
    for entry in data.get("sections", []):
        file_path = entry.get("file")
        if file_path and file_path not in order:
            order.append(file_path)
    return order


def list_doc_files():
    docs = sorted(glob("docs/*.md"))
    if not docs:
        return []
    registry_order = load_existing_order("registry/sections.json")
    ordered = [path for path in registry_order if path in docs]
    remaining = [path for path in docs if path not in ordered]
    return ordered + remaining


def update_doc_anchors(path):
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    new_lines = []
    sections = []
    in_code = False

    for line in lines:
        if line.startswith("```"):
            in_code = not in_code
            new_lines.append(line)
            continue
        if in_code:
            new_lines.append(line)
            continue
        match = HEADING_RE.match(line)
        if match:
            level = len(match.group(1))
            heading_text = match.group(2).strip()

            last_non_empty = len(new_lines) - 1
            while last_non_empty >= 0 and new_lines[last_non_empty].strip() == "":
                last_non_empty -= 1

            existing_anchor_id = None
            if last_non_empty >= 0 and is_anchor_line(new_lines[last_non_empty]):
                existing_anchor_id = get_anchor_id(new_lines[last_non_empty])

            if existing_anchor_id:
                section_id = existing_anchor_id
                anchor_line = new_lines[last_non_empty].strip()
            else:
                section_id = compute_section_id(path, heading_text)
                anchor_line = f"<a id=\"{section_id}\"></a>"

            if last_non_empty >= 0 and is_anchor_line(new_lines[last_non_empty]):
                del new_lines[last_non_empty + 1 :]
                if not existing_anchor_id and new_lines[last_non_empty].strip() != anchor_line:
                    new_lines[last_non_empty] = anchor_line
            else:
                new_lines.append(anchor_line)

            new_lines.append(line)
            sections.append(
                {
                    "id": section_id,
                    "file": path,
                    "heading": heading_text,
                    "level": level,
                }
            )
            continue

        new_lines.append(line)

    original = "\n".join(lines) + "\n"
    updated = "\n".join(new_lines) + "\n"
    if updated != original:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(updated)

    return sections


def main():
    os.chdir(ROOT_DIR)
    doc_files = list_doc_files()
    sections = []
    for path in doc_files:
        sections.extend(update_doc_anchors(path))

    registry = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "version": "1.0.0",
        "description": "Canonical section ID registry for the Universal Brand System",
        "usage_rules": {
            "reference_by": "Use SECTION_* IDs in all cross-references",
            "resolution": "Resolve SECTION_* IDs via this registry to file + anchor",
            "stability": "IDs are anchored explicitly in docs; headings may change without renaming IDs",
        },
        "sections": sections,
    }

    os.makedirs("registry", exist_ok=True)
    with open("registry/sections.json", "w", encoding="utf-8") as handle:
        json.dump(registry, handle, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
