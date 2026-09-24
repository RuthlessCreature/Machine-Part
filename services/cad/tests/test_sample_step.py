import os
from pathlib import Path

from app.cad_engine import ingest_step


def test_uploaded_sample(tmp_path: Path):
    sample = os.environ.get("MACHINE_PART_SAMPLE_STEP")
    if not sample:
        return
    manifest = ingest_step(sample, tmp_path, "sample-5015")
    assert manifest["counts"]["parts"] == 137
    assert manifest["counts"]["assemblies"] == 1
    assert (tmp_path / "assembly.glb").exists()
    assert (tmp_path / "assembly.glb").stat().st_size > 100_000
