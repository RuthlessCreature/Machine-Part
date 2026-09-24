import zipfile
from pathlib import Path

import cadquery as cq
from cadquery import exporters

import app.main as cad_main


def test_zip_candidates_reject_unsafe_paths_and_process_step(tmp_path: Path, monkeypatch):
    root = tmp_path / "work"
    monkeypatch.setattr(cad_main, "WORK_ROOT", root)

    step = tmp_path / "machine.step"
    exporters.export(
        cq.Workplane("XY").box(25, 35, 45).val(),
        str(step),
        exportType="STEP",
    )

    archive = tmp_path / "assembly.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(step, "project/root/machine.step")
        zf.writestr("../evil.step", step.read_bytes())
        zf.writestr("parts/part.sldprt", b"not-a-real-solidworks-file")

    candidates = cad_main._zip_candidates(archive)
    paths = [item["path"] for item in candidates]
    assert "project/root/machine.step" in paths
    assert "../evil.step" not in paths
    assert any(item["requires_converter"] for item in candidates if item["path"].endswith(".sldprt"))

    project_id = "zip-smoke"
    project_dir = root / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    copied_archive = project_dir / "assembly.zip"
    copied_archive.write_bytes(archive.read_bytes())

    result = cad_main._process_selected_archive_member(
        project_id,
        copied_archive,
        "project/root/machine.step",
    )

    assert result["status"] == "ready"
    assert result["summary"]["counts"]["parts"] >= 1
    assert (project_dir / "artifacts" / "manifest.json").exists()
    assert (project_dir / "artifacts" / "assembly.glb").exists()
