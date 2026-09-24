import json
import os
import struct
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
    glb_path = tmp_path / "assembly.glb"
    assert glb_path.stat().st_size > 100_000

    raw = glb_path.read_bytes()
    json_len, _ = struct.unpack_from("<II", raw, 12)
    gltf = json.loads(raw[20:20 + json_len].decode("utf-8").rstrip(" \t\r\n\x00"))
    leaf_ids = {node["id"] for node in manifest["nodes"] if node["kind"] == "part"}
    mesh_node_names = {node.get("name") for node in gltf.get("nodes", []) if "mesh" in node}
    assert leaf_ids == mesh_node_names
