"""Hardened XML parsing shared by every GP/arrangement-XML import path
(security audit, issue #45).

``xml.etree.ElementTree`` has no built-in protection against
entity-expansion ("billion laughs") DoS on untrusted input.
``defusedxml`` hardens both ``parse()`` and ``fromstring()`` against it
when installed. Centralised here so every call site that parses
attacker-influenceable XML (imported Guitar Pro / arrangement files) uses
the same guarded fallback, instead of each duplicating the inline
try/except that lib/gp8_audio_sync.py and lib/gp_autosync.py used locally
before this module existed.

Attacks defusedxml rejects (``EntitiesForbidden``, ``DTDForbidden``, ...)
are normalised to ``ET.ParseError`` so existing ``except ET.ParseError:``
call sites keep working unmodified — a rejected malicious file should be
treated the same as a malformed one, not crash the caller.
"""
import logging
import xml.etree.ElementTree as ET

log = logging.getLogger("feedBack.lib.safe_xml")

try:
    import defusedxml.ElementTree as _safe_ET
    from defusedxml.common import DefusedXmlException as _DefusedXmlException
    _HAVE_DEFUSEDXML = True
except ImportError:
    _safe_ET = None
    _DefusedXmlException = ()
    _HAVE_DEFUSEDXML = False
    log.warning(
        "safe_xml: defusedxml not installed; refusing to parse untrusted XML "
        "(install defusedxml for hardened parsing)"
    )


def safe_parse(source):
    """Hardened equivalent of ``ET.parse(source)``."""
    if not _HAVE_DEFUSEDXML:
        raise ET.ParseError("defusedxml is required to parse untrusted XML")
    try:
        return _safe_ET.parse(source)
    except _DefusedXmlException as e:
        raise ET.ParseError(str(e)) from e


def safe_fromstring(text):
    """Hardened equivalent of ``ET.fromstring(text)``."""
    if not _HAVE_DEFUSEDXML:
        raise ET.ParseError("defusedxml is required to parse untrusted XML")
    try:
        return _safe_ET.fromstring(text)
    except _DefusedXmlException as e:
        raise ET.ParseError(str(e)) from e
