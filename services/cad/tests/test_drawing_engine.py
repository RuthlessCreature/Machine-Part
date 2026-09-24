import json
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from app.cad_engine import build_manifest, load_step
from app.drawing_engine import generate_drawing_bundle_loaded


def test_cylinder_drawing_bundle(tmp_path: Path):
    source = tmp_path / "cylinder.step"
    exporters.export(
        cq.Workplane("XY").circle(10).extrude(35).val(),
        str(source),
        exportType="STEP",
    )

    loaded = load_step(source)
    manifest = build_manifest(loaded, "drawing-smoke")
    parts = [node for node in manifest["nodes"] if node["kind"] == "part"]
    assert len(parts) >= 1

    out = generate_drawing_bundle_loaded(
        loaded,
        "drawing-smoke",
        parts[0]["id"],
        tmp_path / "drawing",
        revision=0,
    )

    for path in out["artifacts"].values():
        artifact = Path(path)
        assert artifact.exists()
        assert artifact.stat().st_size > 0

    assert out["part_id"] == parts[0]["id"]
    assert out["features"]
    assert any(abs(feature["diameter_mm"] - 20.0) < 0.01 for feature in out["features"])


def test_reviewer_directive_changes_rendered_drawing(tmp_path: Path):
    source = tmp_path / "block.step"
    exporters.export(
        cq.Workplane("XY").box(20, 30, 40).val(),
        str(source),
        exportType="STEP",
    )
    loaded = load_step(source)
    manifest = build_manifest(loaded, "drawing-revision")
    part = next(node for node in manifest["nodes"] if node["kind"] == "part")

    base = generate_drawing_bundle_loaded(
        loaded,
        "drawing-revision",
        part["id"],
        tmp_path / "r0",
        revision=0,
    )
    revised = generate_drawing_bundle_loaded(
        loaded,
        "drawing-revision",
        part["id"],
        tmp_path / "r1",
        revision=1,
        directive={
            "drawing": {
                "primary_view": "+X",
                "show_hidden_lines": False,
                "show_overall_dimensions": True,
                "show_feature_table": False,
                "notes": ["Reviewer requested +X primary view."],
                "unresolved_requests": ["Thread callout requires CAD PMI evidence."],
            }
        },
    )

    base_json = json.loads(Path(base["artifacts"]["json"]).read_text(encoding="utf-8"))
    revised_json = json.loads(Path(revised["artifacts"]["json"]).read_text(encoding="utf-8"))

    assert base_json["drawing_options"]["primary_view"] == "-Y"
    assert revised_json["drawing_options"]["primary_view"] == "+X"
    assert revised_json["views"]["front"]["direction"] == [1.0, 0.0, 0.0]
    assert revised_json["drawing_options"]["show_hidden_lines"] is False
    assert "Reviewer requested +X primary view." in revised_json["drawing_options"]["notes"]
    assert revised_json["drawing_options"]["unresolved_requests"]
    assert Path(base["artifacts"]["svg"]).read_text() != Path(revised["artifacts"]["svg"]).read_text()
