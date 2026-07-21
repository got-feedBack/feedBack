"""Wire-compatibility coverage for selectable drum parts."""

from routers.ws_highway import _drum_part_id_for_wire


def test_single_synthesized_part_keeps_legacy_frame_without_part_id():
    parts = [{"id": "drums", "name": "Drums", "drum_tab": {}}]
    assert _drum_part_id_for_wire(parts, "drums") is None


def test_multiple_parts_expose_selected_part_id():
    parts = [
        {"id": "drums", "name": "Drums", "drum_tab": {}},
        {"id": "drums-2", "name": "Aux", "drum_tab": {}},
    ]
    assert _drum_part_id_for_wire(parts, "drums-2") == "drums-2"
    assert _drum_part_id_for_wire(parts, None) is None
