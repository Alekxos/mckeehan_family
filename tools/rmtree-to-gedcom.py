#!/usr/bin/env python3
"""Bootstrap converter: RootsMagic (.rmtree / SQLite) -> GEDCOM 5.5.1.

The site normally builds from the research GEDCOM. This script exists so the
site can be built straight from a RootsMagic file when that is all there is.

Usage:
    python3 tools/rmtree-to-gedcom.py path/to/tree.rmtree out.ged [--media-dir media]
"""
import argparse
import re
import sqlite3
from datetime import date

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

# RootsMagic's "Nickname" field in this file mostly holds middle names
# (Dawn "Marie", Frank "Ellis"). These values are true nicknames.
TRUE_NICKNAMES = {"art", "ben", "bob", "ibbey", "peggy", "molly", "alekxos", "kite", "fid"}


def rm_collation(a, b):
    a, b = (a or "").lower(), (b or "").lower()
    return (a > b) - (a < b)


def rm_date(raw):
    """Convert a RootsMagic date string to a GEDCOM date phrase."""
    if not raw or raw == ".":
        return None
    if raw.startswith("T"):
        return "(" + raw[1:] + ")"
    m = re.match(r"D(.)([+-])(\d{4})(\d{2})(\d{2})", raw)
    if not m:
        return None
    mod, _sign, y, mo, d = m.groups()
    y, mo, d = int(y), int(mo), int(d)
    if y == 0:
        return None
    parts = []
    if d:
        parts.append(str(d))
    if mo:
        parts.append(MONTHS[mo - 1])
    parts.append(str(y))
    prefix = {"B": "BEF ", "A": "AFT ", "F": "FROM ", "T": "TO "}.get(mod, "")
    return prefix + " ".join(parts)


def clean_note(text):
    text = re.sub(r"<[^>]+>", "", text or "")
    return text.strip()


def note_lines(level, text):
    """Emit a NOTE with CONT lines, splitting long lines with CONC."""
    out = []
    first = True
    for line in text.split("\n"):
        chunks = [line[i:i + 200] for i in range(0, len(line), 200)] or [""]
        for j, chunk in enumerate(chunks):
            if first:
                out.append(f"{level} NOTE {chunk}")
                first = False
            elif j == 0:
                out.append(f"{level + 1} CONT {chunk}")
            else:
                out.append(f"{level + 1} CONC {chunk}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rmtree")
    ap.add_argument("out")
    ap.add_argument("--media-dir", default="media")
    ap.add_argument(
        "--merge",
        default="",
        help="Comma-separated duplicate person ids to fold together, e.g. 125=123,126=124",
    )
    args = ap.parse_args()
    merge = {}
    for pair in filter(None, args.merge.split(",")):
        dup, keep = pair.split("=")
        merge[int(dup)] = int(keep)

    def canon(pid):
        return merge.get(pid, pid)

    c = sqlite3.connect(args.rmtree)
    c.create_collation("RMNOCASE", rm_collation)

    tags = {r[0]: r[1] for r in c.execute("SELECT FactTypeID, GedcomTag FROM FactTypeTable")}
    places = {r[0]: r[1] for r in c.execute("SELECT PlaceID, Name FROM PlaceTable")}

    def events(owner_type, owner_id, level=1):
        out = []
        rows = c.execute(
            "SELECT EventType, Date, PlaceID, Details, Note, IsPrivate FROM EventTable "
            "WHERE OwnerType=? AND OwnerID=? ORDER BY SortDate",
            (owner_type, owner_id),
        ).fetchall()
        for etype, d, pid, details, note, _private in rows:
            tag = tags.get(etype) or "EVEN"
            if tag.startswith("_") or len(tag) > 4:
                tag = "EVEN"
            line = f"{level} {tag}"
            if details:
                line += f" {details}"
            out.append(line)
            gd = rm_date(d)
            if gd:
                out.append(f"{level + 1} DATE {gd}")
            if pid and places.get(pid):
                out.append(f"{level + 1} PLAC {places[pid]}")
            if note and clean_note(note):
                out.extend(note_lines(level + 1, clean_note(note)))
        return out

    lines = [
        "0 HEAD",
        "1 SOUR RMTREE_BOOTSTRAP",
        "2 NAME rmtree-to-gedcom.py",
        "1 GEDC",
        "2 VERS 5.5.1",
        "2 FORM LINEAGE-LINKED",
        "1 CHAR UTF-8",
        f"1 DATE {date.today().day} {MONTHS[date.today().month - 1]} {date.today().year}",
    ]

    media = {
        r[0]: r[1]
        for r in c.execute("SELECT MediaID, MediaFile FROM MultimediaTable")
    }
    media_links = {}
    for mid, otype, oid in c.execute("SELECT MediaID, OwnerType, OwnerID FROM MediaLinkTable"):
        if otype == 0:
            media_links.setdefault(oid, []).append(mid)

    fams_of = {}
    famc_of = {}
    fam_alias = {}
    fam_rows = []
    by_parents = {}
    for fid, fa, mo, note in c.execute("SELECT FamilyID, FatherID, MotherID, Note FROM FamilyTable").fetchall():
        fa, mo = canon(fa), canon(mo)
        key = (fa, mo)
        if key in by_parents and (fa or mo):
            fam_alias[fid] = by_parents[key]
            continue
        by_parents[key] = fid
        fam_rows.append((fid, fa, mo, note))
    for fid, fa, mo, _ in fam_rows:
        for p in (fa, mo):
            if p:
                fams_of.setdefault(p, []).append(fid)
    children = {}
    for fid, cid in c.execute("SELECT FamilyID, ChildID FROM ChildTable ORDER BY FamilyID, ChildOrder"):
        fid, cid = fam_alias.get(fid, fid), canon(cid)
        children.setdefault(fid, [])
        if cid not in children[fid]:
            children[fid].append(cid)
            famc_of.setdefault(cid, [])
            if fid not in famc_of[cid]:
                famc_of[cid].append(fid)

    for pid, sex, living, note in c.execute(
        "SELECT PersonID, Sex, Living, Note FROM PersonTable ORDER BY PersonID"
    ).fetchall():
        if pid in merge:
            continue
        name = c.execute(
            "SELECT Given, Surname, Suffix, Nickname, Prefix FROM NameTable WHERE OwnerID=? AND IsPrimary=1",
            (pid,),
        ).fetchone() or ("", "", "", "", "")
        given, surname, suffix, nick, prefix = [(x or "").strip() for x in name]
        nickname = ""
        if nick:
            if nick.lower() in TRUE_NICKNAMES:
                nickname = nick
            elif nick.lower() not in given.lower():
                given = f"{given} {nick}".strip()
        lines.append(f"0 @I{pid}@ INDI")
        full = f"{given} /{surname}/" + (f" {suffix}" if suffix else "")
        lines.append(f"1 NAME {full}")
        if given:
            lines.append(f"2 GIVN {given}")
        if surname:
            lines.append(f"2 SURN {surname}")
        if nickname:
            lines.append(f"2 NICK {nickname}")
        lines.append(f"1 SEX {'M' if sex == 0 else 'F' if sex == 1 else 'U'}")
        if living:
            lines.append("1 RESN privacy")
        lines.extend(events(0, pid))
        if note and clean_note(note):
            lines.extend(note_lines(1, clean_note(note)))
        for mid in media_links.get(pid, []):
            if media.get(mid):
                lines.append(f"1 OBJE")
                lines.append(f"2 FILE {args.media_dir}/{media[mid]}")
                lines.append(f"3 FORM {media[mid].rsplit('.', 1)[-1].lower()}")
        for fid in famc_of.get(pid, []):
            lines.append(f"1 FAMC @F{fid}@")
        for fid in fams_of.get(pid, []):
            lines.append(f"1 FAMS @F{fid}@")

    for fid, fa, mo, note in fam_rows:
        lines.append(f"0 @F{fid}@ FAM")
        if fa:
            lines.append(f"1 HUSB @I{fa}@")
        if mo:
            lines.append(f"1 WIFE @I{mo}@")
        for cid in children.get(fid, []):
            lines.append(f"1 CHIL @I{cid}@")
        lines.extend(events(1, fid))
        for alias, target in fam_alias.items():
            if target == fid:
                lines.extend(events(1, alias))
        if note and clean_note(note):
            lines.extend(note_lines(1, clean_note(note)))

    lines.append("0 TRLR")
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {args.out}: {sum(1 for l in lines if l.endswith(' INDI'))} people, {len(fam_rows)} families")


if __name__ == "__main__":
    main()
