from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.Message import Message_ProgressRange
from OCP.RWGltf import RWGltf_CafWriter
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TColStd import TColStd_IndexedDataMapOfStringString
from OCP.TDF import TDF_Label, TDF_LabelSequence, TDF_Tool
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool


@dataclass
class LoadedStep:
    doc: TDocStd_Document
    shape_tool: Any
    root_labels: TDF_LabelSequence


def _label_name(label: TDF_Label) -> str:
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        try:
            return attr.Get().ToExtString()
        except Exception:
            return str(attr.Get())
    return ""


def _label_entry(label: TDF_Label) -> str:
    value = TCollection_AsciiString()
    TDF_Tool.Entry_s(label, value)
    return value.ToCString()


def _stable_id(project_id: str, entry: str) -> str:
    raw = f"{project_id}:{entry}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


def _bbox(shape: Any) -> dict[str, Any]:
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, True)
    if box.IsVoid():
        return {"min": [0, 0, 0], "max": [0, 0, 0], "size": [0, 0, 0]}
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return {
        "min": [xmin, ymin, zmin],
        "max": [xmax, ymax, zmax],
        "size": [xmax - xmin, ymax - ymin, zmax - zmin],
    }


def _shape_properties(shape: Any) -> dict[str, Any]:
    volume = GProp_GProps()
    surface = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, volume, False, False, False)
    BRepGProp.SurfaceProperties_s(shape, surface, False, False)
    c = volume.CentreOfMass()
    return {
        "bbox_mm": _bbox(shape),
        "volume_mm3": float(volume.Mass()),
        "surface_area_mm2": float(surface.Mass()),
        "center_of_mass_mm": [float(c.X()), float(c.Y()), float(c.Z())],
    }


def load_step(path: str | Path) -> LoadedStep:
    path = str(path)
    doc = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(True)
    reader.SetPropsMode(True)
    status = reader.ReadFile(path)
    if "RetDone" not in str(status):
        raise ValueError(f"STEP read failed: {status}")
    if not reader.Transfer(doc):
        raise ValueError("STEP transfer to XCAF failed")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise ValueError("STEP contains no free shapes")
    return LoadedStep(doc=doc, shape_tool=shape_tool, root_labels=roots)


def _referred(shape_tool: Any, label: TDF_Label) -> TDF_Label:
    if shape_tool.IsReference_s(label):
        target = TDF_Label()
        shape_tool.GetReferredShape_s(label, target)
        return target
    return label


def _children(shape_tool: Any, label: TDF_Label) -> list[TDF_Label]:
    referred = _referred(shape_tool, label)
    if not shape_tool.IsAssembly_s(referred):
        return []
    seq = TDF_LabelSequence()
    shape_tool.GetComponents_s(referred, seq, False)
    return [seq.Value(i) for i in range(1, seq.Length() + 1)]


def build_manifest(loaded: LoadedStep, project_id: str) -> dict[str, Any]:
    shape_tool = loaded.shape_tool
    roots = [loaded.root_labels.Value(i) for i in range(1, loaded.root_labels.Length() + 1)]
    nodes: list[dict[str, Any]] = []

    def visit(label: TDF_Label, parent_id: str | None, depth: int) -> str:
        referred = _referred(shape_tool, label)
        entry = _label_entry(label)
        node_id = _stable_id(project_id, entry)
        display_name = _label_name(label) or _label_name(referred) or entry
        children = _children(shape_tool, label)
        shape = shape_tool.GetShape_s(label)
        is_assembly = bool(children)
        props = _shape_properties(shape) if not is_assembly else {"bbox_mm": _bbox(shape)}
        node = {
            "id": node_id,
            "label_entry": entry,
            "source_label_entry": _label_entry(referred),
            "name": display_name,
            "parent_id": parent_id,
            "depth": depth,
            "kind": "assembly" if is_assembly else "part",
            "children": [],
            **props,
        }
        nodes.append(node)
        for child in children:
            child_id = visit(child, node_id, depth + 1)
            node["children"].append(child_id)
        return node_id

    root_ids = [visit(root, None, 0) for root in roots]
    part_nodes = [n for n in nodes if n["kind"] == "part"]
    assembly_nodes = [n for n in nodes if n["kind"] == "assembly"]
    return {
        "schema_version": 1,
        "project_id": project_id,
        "units": "mm",
        "root_ids": root_ids,
        "counts": {
            "nodes": len(nodes),
            "assemblies": len(assembly_nodes),
            "parts": len(part_nodes),
        },
        "nodes": nodes,
    }


def apply_viewer_ids(loaded: LoadedStep, project_id: str) -> None:
    """Rename leaf occurrence labels to stable IDs for unambiguous GLB picking.

    The manifest is built before this mutation, so human-facing CAD names remain intact there.
    """
    shape_tool = loaded.shape_tool

    def visit(label: TDF_Label) -> None:
        children = _children(shape_tool, label)
        if not children:
            viewer_id = _stable_id(project_id, _label_entry(label))
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(viewer_id))
            return
        for child in children:
            visit(child)

    for i in range(1, loaded.root_labels.Length() + 1):
        visit(loaded.root_labels.Value(i))


def export_glb(loaded: LoadedStep, out_path: str | Path, linear_deflection: float | None = None) -> dict[str, Any]:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    shape = loaded.shape_tool.GetOneShape()
    box = _bbox(shape)
    diag = math.sqrt(sum(v * v for v in box["size"]))
    if linear_deflection is None:
        linear_deflection = min(1.0, max(0.08, diag * 0.0002))

    mesh = BRepMesh_IncrementalMesh(shape, linear_deflection, False, 0.5, True)
    if not mesh.IsDone():
        raise RuntimeError("OCCT triangulation failed")

    writer = RWGltf_CafWriter(str(out_path), True)
    writer.SetParallel(True)
    writer.SetMergeFaces(True)
    writer.SetToEmbedTexturesInGlb(True)
    file_info = TColStd_IndexedDataMapOfStringString()
    if not writer.Perform(loaded.doc, file_info, Message_ProgressRange()):
        raise RuntimeError("GLB export failed")
    return {
        "path": str(out_path),
        "bytes": out_path.stat().st_size,
        "linear_deflection_mm": linear_deflection,
        "bbox_mm": box,
    }


def ingest_step(source_path: str | Path, output_dir: str | Path, project_id: str) -> dict[str, Any]:
    source_path = Path(source_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    loaded = load_step(source_path)
    manifest = build_manifest(loaded, project_id)
    apply_viewer_ids(loaded, project_id)
    glb = export_glb(loaded, output_dir / "assembly.glb")
    manifest["artifacts"] = {"assembly_glb": glb}
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest
