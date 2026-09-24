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
