from pathlib import Path

import cadquery as cq
from cadquery import exporters

from app.cad_engine import build_manifest, load_step
from app.costing_engine import generate_cost_bundle


def test_cost_bundle_has_auditable_outputs(tmp_path: Path):
    source = tmp_path / "part.step"
    exporters.export(
        cq.Workplane("XY").box(20, 30, 40).val(),
        str(source),
        exportType="STEP",
    )
    manifest = build_manifest(load_step(source), "cost-smoke")
    part_ids = [node["id"] for node in manifest["nodes"] if node["kind"] == "part"]

    result = generate_cost_bundle(
        source,
        "cost-smoke",
        part_ids,
        tmp_path / "cost",
        policy={
            "material": {
                "name": "6061-T6",
                "price_per_kg": 30,
            },
            "commercial": {"gross_margin_pct": 0.25},
        },
    )

    assert result["quote_complete"] is True
    assert result["summary"]["quoted_price"] > result["summary"]["estimated_cost"] > 0
    for path in result["artifacts"].values():
        artifact = Path(path)
        assert artifact.exists()
        assert artifact.stat().st_size > 0


def test_missing_material_price_is_flagged_incomplete(tmp_path: Path):
    source = tmp_path / "part.step"
    exporters.export(cq.Workplane("XY").box(10, 10, 10).val(), str(source), exportType="STEP")
    manifest = build_manifest(load_step(source), "cost-incomplete")
    part_ids = [node["id"] for node in manifest["nodes"] if node["kind"] == "part"]
    result = generate_cost_bundle(source, "cost-incomplete", part_ids, tmp_path / "cost")
    assert result["quote_complete"] is False
