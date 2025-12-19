#!/usr/bin/env python3
import json
import os
import sys
from glob import glob
from pathlib import Path

from section_utils import extract_section_refs, get_anchor_id, is_anchor_line

ROOT_DIR = Path(__file__).resolve().parents[1]


def load_registry(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_anchor_ids(doc_paths):
    anchors_by_file = {}
    for path in doc_paths:
        with open(path, "r", encoding="utf-8") as handle:
            anchors = []
            for line in handle:
                if not is_anchor_line(line):
                    continue
                anchor_id = get_anchor_id(line)
                if anchor_id:
                    anchors.append(anchor_id)
            anchors_by_file[path] = anchors
    return anchors_by_file


def collect_section_refs(paths):
    refs = {}
    for path in paths:
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read()
        matches = extract_section_refs(content)
        if matches:
            refs[path] = matches
    return refs


def main():
    os.chdir(ROOT_DIR)
    registry_path = "registry/sections.json"
    if not os.path.exists(registry_path):
        print("Missing registry/sections.json")
        sys.exit(1)

    registry = load_registry(registry_path)
    sections = registry.get("sections", [])
    ids = [entry.get("id") for entry in sections if entry.get("id")]
    duplicates = sorted({item for item in ids if ids.count(item) > 1})

    id_to_file = {entry["id"]: entry["file"] for entry in sections if "id" in entry and "file" in entry}
    valid_ids = set(id_to_file.keys())

    doc_paths = sorted(glob("docs/*.md"))
    anchor_ids_by_file = collect_anchor_ids(doc_paths)
    anchor_ids = set()
    for anchor_list in anchor_ids_by_file.values():
        anchor_ids.update(anchor_list)

    scan_paths = sorted(glob("**/*.md", recursive=True) + glob("**/*.json", recursive=True))
    refs_by_file = collect_section_refs(scan_paths)

    errors = []

    if duplicates:
        errors.append(f"Duplicate SECTION IDs in registry: {', '.join(duplicates)}")

    missing_refs = []
    for path, refs in refs_by_file.items():
        for ref in refs:
            if ref not in valid_ids:
                missing_refs.append(f"{path}: {ref}")
    if missing_refs:
        errors.append("SECTION refs missing from registry:\n  " + "\n  ".join(sorted(missing_refs)))

    missing_anchors = []
    for section_id, file_path in id_to_file.items():
        anchors = set(anchor_ids_by_file.get(file_path, []))
        if section_id not in anchors:
            missing_anchors.append(f"{file_path}: {section_id}")
    if missing_anchors:
        errors.append("Registry IDs missing anchor tags:\n  " + "\n  ".join(sorted(missing_anchors)))

    orphan_anchors = sorted(anchor_ids - valid_ids)
    if orphan_anchors:
        errors.append("Anchor IDs missing from registry:\n  " + "\n  ".join(orphan_anchors))

    if errors:
        print("Section validation failed:")
        for entry in errors:
            print(f"- {entry}")
        sys.exit(1)

    print("Section validation passed.")


if __name__ == "__main__":
    main()
