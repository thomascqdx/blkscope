"""Minimal Markdown -> HTML converter for the embedded manual (design 5.6).

Stdlib only. Supported subset: ATX headings ``#`` .. ``###`` (each gets a
sequential ``id="m-<n>"``), paragraphs, unordered ``- `` / ``* `` and ordered
``1. `` lists nested by indentation (>= 2 spaces), GFM tables (header row +
``|---|`` separator, cells trimmed, alignment colons tolerated), fenced
````` code blocks (content escaped, no inline processing, language ignored),
``> `` blockquotes, and inline ``code``, ``**bold**``, ``[text](url)`` where
only http(s)/# urls become links (everything else renders as plain text).
All literal text is HTML-escaped first.
"""

from __future__ import annotations

import html as _html
import re

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
_LIST_RE = re.compile(r"^(\s*)([-*]|\d+\.)\s+(.*?)\s*$")
_FENCE_RE = re.compile(r"^\s*```")
_BQ_RE = re.compile(r"^\s*>\s?")
_TABLE_SEP_RE = re.compile(r"^[\s|:\-]+$")
_ORDERED_RE = re.compile(r"\d")
_SENTINEL_RE = re.compile(r"\x00(\d+)\x00")


def _is_table_sep(line: str) -> bool:
    """A GFM separator row: only |, -, :, spaces; needs both | and -."""
    s = line.strip()
    return "|" in s and "-" in s and bool(_TABLE_SEP_RE.match(s))


def _cells(line: str) -> list:
    t = line.strip()
    if t.startswith("|"):
        t = t[1:]
    if t.endswith("|"):
        t = t[:-1]
    return [c.strip() for c in t.split("|")]


def _inline(text: str) -> str:
    """Escape, then apply ``code`` / ``**bold**`` / ``[text](url)``.

    Code spans and links are stashed as sentinels before the bold pass so
    ``**`` inside a code span is never formatted and a url never escapes
    twice."""
    stash = []

    def put(fragment: str) -> str:
        stash.append(fragment)
        return "\x00%d\x00" % (len(stash) - 1)

    s = re.sub(r"`([^`]+)`",
               lambda m: put("<code>%s</code>" % _html.escape(m.group(1))),
               text)

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2).strip()
        if re.match(r"(?i)^(https?://|#)", url):
            return put('<a href="%s">%s</a>'
                       % (_html.escape(url, quote=True),
                          _html.escape(label)))
        return put(_html.escape(label))

    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    s = _html.escape(s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return _SENTINEL_RE.sub(lambda m: stash[int(m.group(1))], s)


def md_to_html(text: str) -> str:
    lines = text.replace("\r\n", "\n").split("\n")
    n = len(lines)
    out = []
    hnum = 0
    i = 0

    def starts_block(j: int) -> bool:
        """Does line j begin a non-paragraph block?"""
        l, s = lines[j], lines[j].strip()
        if not s:
            return True
        if _FENCE_RE.match(l) or _BQ_RE.match(l):
            return True
        if _HEADING_RE.match(l) or _LIST_RE.match(l):
            return True
        return j + 1 < n and "|" in l and _is_table_sep(lines[j + 1])

    while i < n:
        line, stripped = lines[i], lines[i].strip()
        if not stripped:
            i += 1
            continue

        if _FENCE_RE.match(line):                       # ``` code block
            i += 1
            buf = []
            while i < n and not _FENCE_RE.match(lines[i]):
                buf.append(lines[i])
                i += 1
            i += 1                                       # closing fence
            out.append("<pre><code>%s</code></pre>"
                       % _html.escape("\n".join(buf)))
            continue

        m = _HEADING_RE.match(line)                      # # .. ### heading
        if m:
            lvl = len(m.group(1))
            hnum += 1
            out.append('<h%d id="m-%d">%s</h%d>'
                       % (lvl, hnum, _inline(m.group(2)), lvl))
            i += 1
            continue

        if _BQ_RE.match(line):                           # > blockquote
            buf = []
            while i < n and _BQ_RE.match(lines[i]):
                buf.append(_BQ_RE.sub("", lines[i]))
                i += 1
            out.append("<blockquote><p>%s</p></blockquote>"
                       % _inline(" ".join(buf)))
            continue

        if _LIST_RE.match(line):                         # - / * / 1. lists
            stack = []                                   # (indent, tag)
            while i < n:
                m = _LIST_RE.match(lines[i])
                if not m:
                    break
                ind = len(m.group(1).replace("\t", "    "))
                tag = "ol" if _ORDERED_RE.match(m.group(2)) else "ul"
                while stack and ind < stack[-1][0]:
                    out.append("</%s>" % stack.pop()[1])
                if not stack or ind > stack[-1][0]:
                    out.append("<%s>" % tag)
                    stack.append((ind, tag))
                elif stack[-1][1] != tag:
                    out.append("</%s>" % stack.pop()[1])
                    out.append("<%s>" % tag)
                    stack.append((ind, tag))
                out.append("<li>%s</li>" % _inline(m.group(3)))
                i += 1
            while stack:
                out.append("</%s>" % stack.pop()[1])
            continue

        if i + 1 < n and "|" in line \
                and _is_table_sep(lines[i + 1]):         # GFM table
            head = _cells(line)
            i += 2
            rows = []
            while i < n and lines[i].strip() and "|" in lines[i] \
                    and not _is_table_sep(lines[i]):
                rows.append(_cells(lines[i]))
                i += 1
            tb = ["<table><thead><tr>"]
            tb += ["<th>%s</th>" % _inline(c) for c in head]
            tb.append("</tr></thead><tbody>")
            for r in rows:
                tb.append("<tr>")
                tb += ["<td>%s</td>" % _inline(c) for c in r]
                tb.append("</tr>")
            tb.append("</tbody></table>")
            out.append("".join(tb))
            continue

        buf = []                                          # paragraph
        while i < n and not starts_block(i):
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % _inline(" ".join(buf)))

    return "\n".join(out)
