"""safe_xml hardens GP/arrangement XML parsing against entity-expansion
("billion laughs") DoS on untrusted input (security audit, issue #45).

xml.etree.ElementTree has no built-in protection against this; defusedxml
does, when installed (it's a normal requirements.txt dependency now — see
requirements.txt's comment on this). Both safe_parse()/safe_fromstring()
must reject the classic billion-laughs payload, and normal XML must keep
parsing exactly as before.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

import safe_xml

# The classic "billion laughs" payload: each entity expands to 10x the
# previous, so `lol9` alone would expand to ~10^9 copies of "lol" if
# entity expansion isn't blocked. Kept small enough (lol4) that even an
# UNPROTECTED stdlib parse wouldn't hang the test suite — the assertion is
# about REJECTION, not about surviving a full-size attack.
BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<song>&lol4;</song>
"""

NORMAL_XML = '<song><arrangement>Lead</arrangement></song>'


def test_defusedxml_is_actually_installed():
    # The whole point of requirements.txt's addition — if this ever regresses
    # (e.g. a requirements sync drops it), every other assertion in this file
    # would silently start exercising the stdlib fallback instead of the
    # hardened path, so pin it explicitly.
    assert safe_xml._HAVE_DEFUSEDXML, (
        "defusedxml not installed — safe_xml is silently running unhardened. "
        "Check requirements.txt."
    )


def test_safe_fromstring_rejects_billion_laughs():
    with pytest.raises(ET.ParseError):
        safe_xml.safe_fromstring(BILLION_LAUGHS)


def test_safe_parse_rejects_billion_laughs_from_a_file(tmp_path):
    p = tmp_path / "bomb.xml"
    p.write_text(BILLION_LAUGHS, encoding="utf-8")
    with pytest.raises(ET.ParseError):
        safe_xml.safe_parse(str(p))


def test_safe_fromstring_still_parses_normal_xml():
    root = safe_xml.safe_fromstring(NORMAL_XML)
    assert root.tag == "song"
    assert root.find("arrangement").text == "Lead"


def test_safe_parse_still_parses_normal_xml_from_a_file(tmp_path):
    p = tmp_path / "song.xml"
    p.write_text(NORMAL_XML, encoding="utf-8")
    root = safe_xml.safe_parse(str(p)).getroot()
    assert root.tag == "song"


def test_safe_parse_fails_closed_without_defusedxml(tmp_path, monkeypatch):
    p = tmp_path / "song.xml"
    p.write_text(NORMAL_XML, encoding="utf-8")
    monkeypatch.setattr(safe_xml, "_HAVE_DEFUSEDXML", False)
    monkeypatch.setattr(ET, "parse", lambda *_args, **_kwargs: pytest.fail("stdlib parser called"))
    with pytest.raises(ET.ParseError, match="defusedxml is required"):
        safe_xml.safe_parse(str(p))


def test_safe_fromstring_fails_closed_without_defusedxml(monkeypatch):
    monkeypatch.setattr(safe_xml, "_HAVE_DEFUSEDXML", False)
    monkeypatch.setattr(ET, "fromstring", lambda *_args, **_kwargs: pytest.fail("stdlib parser called"))
    with pytest.raises(ET.ParseError, match="defusedxml is required"):
        safe_xml.safe_fromstring(NORMAL_XML)


def test_safe_fromstring_raises_parseerror_on_genuinely_malformed_xml():
    # Ordinary malformed-XML behavior must be unchanged (still ET.ParseError,
    # not some other exception type) so existing `except ET.ParseError:`
    # call sites keep working for the mundane case too.
    with pytest.raises(ET.ParseError):
        safe_xml.safe_fromstring("<song><unclosed>")
