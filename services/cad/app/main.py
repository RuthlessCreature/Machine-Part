from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse

from .cad_engine import ingest_step, load_step
from .drawing_engine import generate_drawing_bundle_loaded

app = FastAPI(title="Machine Part CAD Service", version="0.2.0")
WORK_ROOT = Path("/tmp/machine-part")
SUPPORTED_STEP = {".step", ".stp"}
NATIVE_SW = {".sldasm", ".sldprt"}


def safe_name(name: str) -> str:
    return Path(name).name.replace("..", "_")


def source_path(project_id: str) -> Path:
    job_dir = WORK_ROOT / project_id
    source_meta = job_dir / "source.json"
    if not source_meta.exists():
        raise HTTPException(409, "Source is not loaded in this CAD container")
    source_name = json.loads(source_meta.read_text(encoding="utf-8"))["filename"]
    path = job_dir / source_name
    if not path.exists():
        raise HTTPException(409, "Source CAD file is missing")
    return path


def artifact_path(project_id: str, relative_path: str) -> Path:
    root = (WORK_ROOT / project_id / "artifacts").resolve()
    path = (root / relative_path).resolve()
    if root != path and root not in path.parents:
        raise HTTPException(400, "Invalid artifact path")
    if not path.is_file():
        raise HTTPException(404, "Artifact not found")
    return path


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "cad", "version": "0.2.0"}


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
    (job_dir / "source.json").write_text(json.dumps({"filename": filename}), encoding="utf-8")

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


@app.post("/v1/jobs/{project_id}/draw")
async def draw(project_id: str, request: Request) -> dict:
    body = await request.json()
    part_ids = body.get("part_ids") or []
    revision = int(body.get("revision") or 0)
    if not isinstance(part_ids, list) or not part_ids:
        raise HTTPException(400, "part_ids must be a non-empty array")
    if len(part_ids) > 500:
        raise HTTPException(400, "Too many parts in one draw request")

    source = source_path(project_id)
    if source.suffix.lower() not in SUPPORTED_STEP:
        raise HTTPException(409, "Selected source must first be converted to STEP/STP")
    loaded = load_step(source)

    index = []
    for part_id in part_ids:
        part_id = str(part_id)
        try:
            result = generate_drawing_bundle_loaded(
                loaded,
                project_id,
                part_id,
                WORK_ROOT / project_id / "artifacts" / "drawings" / part_id / f"r{revision}",
                revision,
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        prefix = f"drawings/{part_id}/r{revision}"
        index.append({
            **{k: v for k, v in result.items() if k != "artifacts"},
            "artifacts": {
                "json": f"{prefix}/drawing.json",
                "svg": f"{prefix}/drawing.svg",
                "pdf": f"{prefix}/drawing.pdf",
                "dxf": f"{prefix}/drawing.dxf",
            },
        })

    payload = {
        "schema_version": 1,
        "project_id": project_id,
        "revision": revision,
        "count": len(index),
        "drawings": index,
        "release_status": "draft_requires_human_review",
    }
    index_path = WORK_ROOT / project_id / "artifacts" / "drawings" / f"r{revision}-index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


@app.get("/v1/jobs/{project_id}/manifest")
def get_manifest(project_id: str) -> FileResponse:
    return FileResponse(artifact_path(project_id, "manifest.json"), media_type="application/json")


@app.get("/v1/jobs/{project_id}/artifacts/{relative_path:path}")
def get_artifact(project_id: str, relative_path: str) -> FileResponse:
    path = artifact_path(project_id, relative_path)
    suffix = path.suffix.lower()
    media = {
        ".glb": "model/gltf-binary",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".dxf": "application/dxf",
    }.get(suffix, "application/octet-stream")
    return FileResponse(path, media_type=media, filename=path.name)
