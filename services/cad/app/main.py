from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse

from .cad_engine import ingest_step

app = FastAPI(title="Machine Part CAD Service", version="0.1.0")
WORK_ROOT = Path("/tmp/machine-part")
SUPPORTED_STEP = {".step", ".stp"}
NATIVE_SW = {".sldasm", ".sldprt"}


def safe_name(name: str) -> str:
    return Path(name).name.replace("..", "_")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "cad", "version": "0.1.0"}


@app.post("/v1/jobs/{project_id}/ingest")
async def ingest(project_id: str, request: Request, x_filename: str = Header(default="source.step")) -> dict:
    job_dir = WORK_ROOT / project_id
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_name(x_filename)
    source = job_dir / filename
    with source.open("wb") as f:
        async for chunk in request.stream():
            f.write(chunk)

    ext = source.suffix.lower()
    if ext in SUPPORTED_STEP:
        manifest = ingest_step(source, job_dir / "artifacts", project_id)
        return {
            "status": "ready",
            "summary": {"counts": manifest["counts"], "root_ids": manifest["root_ids"]},
            "artifacts": ["manifest.json", "assembly.glb"],
        }

    if ext == ".zip":
        try:
            with zipfile.ZipFile(source) as zf:
                candidates = [
                    n for n in zf.namelist()
                    if Path(n).suffix.lower() in SUPPORTED_STEP | NATIVE_SW
                ]
        except zipfile.BadZipFile as exc:
            raise HTTPException(400, "Invalid ZIP archive") from exc
        return {
            "status": "assembly_selection_required",
            "candidates": candidates,
            "note": "V1 directly processes STEP/STP in ZIP. Native SolidWorks requires a converter adapter.",
        }

    if ext in NATIVE_SW:
        return {
            "status": "converter_required",
            "format": ext,
            "note": "Native SolidWorks is proprietary. Configure a CAD converter adapter instead of faking geometry parsing.",
        }
    raise HTTPException(415, f"Unsupported CAD format: {ext or 'unknown'}")


@app.get("/v1/jobs/{project_id}/manifest")
def get_manifest(project_id: str) -> FileResponse:
    path = WORK_ROOT / project_id / "artifacts" / "manifest.json"
    if not path.exists():
        raise HTTPException(404, "Manifest not found")
    return FileResponse(path, media_type="application/json")


@app.get("/v1/jobs/{project_id}/artifacts/{artifact_name}")
def get_artifact(project_id: str, artifact_name: str) -> FileResponse:
    if artifact_name not in {"assembly.glb", "manifest.json"}:
        raise HTTPException(404, "Unknown artifact")
    path = WORK_ROOT / project_id / "artifacts" / artifact_name
    if not path.exists():
        raise HTTPException(404, "Artifact not found")
    media = "model/gltf-binary" if artifact_name.endswith(".glb") else "application/json"
    return FileResponse(path, media_type=media, filename=artifact_name)
