from pathlib import Path

import cadquery as cq
from cadquery import exporters

from app.cad_engine import ingest_step


def test_generated_box_step(tmp_path: Path):
    source = tmp_path / "box.step"
    exporters.export(cq.Workplane("XY").box(20, 30, 40).val(), str(source), exportType="STEP")

    out = tmp_path / "out"
    manifest = ingest_step(source, out, "smoke-box")

    assert manifest["counts"]["parts"] >= 1
    assert manifest["counts"]["nodes"] >= 1
    assert (out / "manifest.json").exists()
    assert (out / "assembly.glb").stat().st_size > 0
