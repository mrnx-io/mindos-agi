import os
import re
import unicodedata

ANCHOR_RE = re.compile(r"^<a id=\"(SECTION_[A-Z0-9_]+)\"></a>$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
SECTION_REF_RE = re.compile(r"SECTION_[A-Z0-9_]+")

FILE_PREFIXES = {
    "00-gate.md": "GATE",
    "00-orchestration.md": "ORCH",
    "01-manifesto.md": "MANIFESTO",
    "02-covenant.md": "COVENANT",
    "03-sumi-breath.md": "SUMI_BREATH",
    "04-tradeoff-ladder.md": "TRADEOFF",
    "05-canon.md": "CANON",
    "06-choreography.md": "CHOREO",
    "07-storefront.md": "STOREFRONT",
}


def file_prefix(file_path):
    base = os.path.basename(file_path)
    if base in FILE_PREFIXES:
        return FILE_PREFIXES[base]
    stem = os.path.splitext(base)[0]
    stem = re.sub(r"^\d+[-_]*", "", stem)
    return slugify_heading(stem)


def strip_heading_prefix(text):
    return re.sub(r"^(?:[IVX]+|\d+)(?:-[A-Z])?\.\s+", "", text.strip())


def slugify_heading(text):
    text = strip_heading_prefix(text)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", " ", text)
    tokens = cleaned.split()
    merged = []
    buffer = ""
    for token in tokens:
        if len(token) == 1 and token.isalpha():
            buffer += token
            continue
        if buffer:
            merged.append(buffer)
            buffer = ""
        merged.append(token)
    if buffer:
        merged.append(buffer)
    return "_".join(merged).upper()


def compute_section_id(file_path, heading_text):
    prefix = file_prefix(file_path)
    slug = slugify_heading(heading_text)
    return f"SECTION_{prefix}_{slug}"


def iter_headings(lines):
    in_code = False
    for idx, line in enumerate(lines):
        stripped = line.rstrip("\n")
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        match = HEADING_RE.match(stripped)
        if not match:
            continue
        level = len(match.group(1))
        heading_text = match.group(2).strip()
        yield idx, level, heading_text


def extract_section_refs(text):
    return SECTION_REF_RE.findall(text)


def is_anchor_line(line):
    return ANCHOR_RE.match(line.strip())


def get_anchor_id(line):
    match = ANCHOR_RE.match(line.strip())
    return match.group(1) if match else None
