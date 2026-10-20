"""mdlite.py: Markdown-subset -> HTML for the embedded manual."""

from blkscope.mdlite import md_to_html


def test_headings_get_sequential_ids():
    out = md_to_html("# T\n\n## A\n\n### B\n\n## C\n")
    assert '<h1 id="m-1">T</h1>' in out
    assert '<h2 id="m-2">A</h2>' in out
    assert '<h3 id="m-3">B</h3>' in out
    assert '<h2 id="m-4">C</h2>' in out


def test_paragraphs_join_lines_and_escape():
    out = md_to_html("first line <b>bold?</b>\nsecond line\n\nnew para\n")
    assert "<p>first line &lt;b&gt;bold?&lt;/b&gt; second line</p>" in out
    assert "<p>new para</p>" in out
    assert "<b>" not in out


def test_nested_lists():
    out = md_to_html("- a\n- b\n  - b1\n    - b1x\n  - b2\n- c\n")
    assert out.count("<ul>") == 3
    assert out.count("</ul>") == 3
    assert "<li>b1x</li>" in out
    # nesting order: innermost list opened last, closed first
    assert out.index("<li>b1x</li>") < out.index("<li>b2</li>")


def test_ordered_list():
    out = md_to_html("1. one\n2. two\n  - sub\n")
    assert "<ol>" in out and "</ol>" in out
    assert "<ul>" in out and "<li>sub</li>" in out


def test_gfm_table():
    out = md_to_html("| 键 | 作用 |\n|---|---:|\n| W | 放大 |\n| `C` | **配色** |\n")
    assert "<th>键</th>" in out and "<th>作用</th>" in out
    assert "<td>W</td>" in out and "<td>放大</td>" in out
    assert "<td><code>C</code></td>" in out
    assert "<td><strong>配色</strong></td>" in out


def test_code_fence_is_literal_and_escaped():
    md = "```python\n<script>alert(1)</script>\n**x** not bold\n```\n"
    out = md_to_html(md)
    assert "<pre><code>" in out
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in out
    assert "**x** not bold" in out            # literal, not bolded
    assert "<strong>" not in out
    assert "<script>" not in out


def test_inline_code_not_bolded():
    out = md_to_html("use `**x**` here\n")
    assert "<code>**x**</code>" in out
    assert "<strong>" not in out


def test_bold():
    out = md_to_html("a **bold** b\n")
    assert "a <strong>bold</strong> b" in out


def test_links():
    out = md_to_html("[site](https://x.example/a?b=1) and "
                     "[anchor](#m-2) and [bad](javascript:alert(1)) "
                     "and [file](C:\\x)\n")
    assert '<a href="https://x.example/a?b=1">site</a>' in out
    assert '<a href="#m-2">anchor</a>' in out
    assert "javascript:alert" not in out       # not linked, text only
    assert "bad" in out
    assert "file" in out
    assert "<a href=\"javascript" not in out
    assert "<a href=\"C:" not in out


def test_blockquote():
    out = md_to_html("> note line\n> second\n")
    assert "<blockquote><p>note line second</p></blockquote>" in out


def test_blank_and_empty_input():
    assert md_to_html("") == ""
    assert md_to_html("\n\n\n") == ""
