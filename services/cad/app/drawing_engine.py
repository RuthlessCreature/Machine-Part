from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Iterable

import svgwrite
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Line
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TDF import TDF_Label
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

from .cad_engine import (
    LoadedStep,
    _children,
    _label_entry,
    _label_name,
    _referred,
    _stable_id,
    load_step,
)

VIEW_PRESETS = {
    "-Y": {"front": (0.0, -1.0, 0.0), "top": (0.0, 0.0, 1.0), "right": (1.0, 0.0, 0.0)},
    "+Y": {"front": (0.0, 1.0, 0.0), "top": (0.0, 0.0, 1.0), "right": (-1.0, 0.0, 0.0)},
    "+X": {"front": (1.0, 0.0, 0.0), "top": (0.0, 0.0, 1.0), "right": (0.0, 1.0, 0.0)},
    "-X": {"front": (-1.0, 0.0, 0.0), "top": (0.0, 0.0, 1.0), "right": (0.0, -1.0, 0.0)},
    "+Z": {"front": (0.0, 0.0, 1.0), "top": (0.0, 1.0, 0.0), "right": (1.0, 0.0, 0.0)},
    "-Z": {"front": (0.0, 0.0, -1.0), "top": (0.0, -1.0, 0.0), "right": (1.0, 0.0, 0.0)},
}

DEFAULT_DIRECTIVE = {
    "primary_view": "-Y",
    "show_hidden_lines": True,
    "show_overall_dimensions": True,
    "show_feature_table": True,
    "notes": [],
    "unresolved_requests": [],
}


def normalize_directive(value: dict[str, Any] | None) -> dict[str, Any]:
    source = value or {}
    if isinstance(source.get("drawing"), dict):
        source = {**source, **source["drawing"]}
    out = dict(DEFAULT_DIRECTIVE)
    primary = str(source.get("primary_view") or source.get("front") or "-Y").upper()
    out["primary_view"] = primary if primary in VIEW_PRESETS else "-Y"
    for key in ("show_hidden_lines", "show_overall_dimensions", "show_feature_table"):
        if isinstance(source.get(key), bool):
            out[key] = source[key]
    out["notes"] = [str(x)[:160] for x in source.get("notes", []) if str(x).strip()][:8]
    out["unresolved_requests"] = [
        str(x)[:220] for x in source.get("unresolved_requests", []) if str(x).strip()
    ][:8]
    return out


def _leaf_labels(loaded: LoadedStep) -> Iterable[TDF_Label]:
    stack = [loaded.root_labels.Value(i) for i in range(1, loaded.root_labels.Length() + 1)]
    while stack:
        label = stack.pop()
        children = _children(loaded.shape_tool, label)
        if children:
            stack.extend(reversed(children))
        else:
            yield label


def find_part_label(loaded: LoadedStep, project_id: str, part_id: str) -> TDF_Label:
    for label in _leaf_labels(loaded):
        if _stable_id(project_id, _label_entry(label)) == part_id:
            return label
    raise KeyError(f"Part id not found: {part_id}")


def _display_name(loaded: LoadedStep, label: TDF_Label) -> str:
    referred = _referred(loaded.shape_tool, label)
    return _label_name(label) or _label_name(referred) or _label_entry(label)


def _sample_edge(edge: Any, curve_points: int = 36) -> list[list[float]]:
    curve = BRepAdaptor_Curve(edge)
    first, last = float(curve.FirstParameter()), float(curve.LastParameter())
    if not math.isfinite(first) or not math.isfinite(last):
        return []
    n = 2 if curve.GetType() == GeomAbs_Line else curve_points
    if abs(last - first) < 1e-12:
        p = curve.Value(first)
        return [[float(p.X()), float(p.Y())]]
    result = []
    for i in range(n):
        p = curve.Value(first + (last - first) * i / (n - 1))
        result.append([float(p.X()), float(p.Y())])
    return result


def _compound_edges(compound: Any, hidden: bool) -> list[dict[str, Any]]:
    if compound.IsNull():
        return []
    result = []
    explorer = TopExp_Explorer(compound, TopAbs_EDGE)
    while explorer.More():
        pts = _sample_edge(TopoDS.Edge_s(explorer.Current()))
        if len(pts) >= 2:
            result.append({"hidden": hidden, "points": pts})
        explorer.Next()
    return result


def project_shape(shape: Any, direction: tuple[float, float, float]) -> list[dict[str, Any]]:
    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*direction))))
    algo.Update()
    algo.Hide()
    out = HLRBRep_HLRToShape(algo)
    return _compound_edges(out.VCompound(), False) + _compound_edges(out.HCompound(), True)


def _bounds(edges: list[dict[str, Any]]) -> dict[str, float]:
    pts = [p for edge in edges for p in edge["points"]]
    if not pts:
        return {"xmin": 0, "ymin": 0, "xmax": 0, "ymax": 0, "width": 0, "height": 0}
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
    return {
        "xmin": xmin,
        "ymin": ymin,
        "xmax": xmax,
        "ymax": ymax,
        "width": xmax - xmin,
        "height": ymax - ymin,
    }


def _cylinders(shape: Any) -> list[dict[str, Any]]:
    result = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        surf = BRepAdaptor_Surface(face, True)
        if surf.GetType() == GeomAbs_Cylinder:
            cyl = surf.Cylinder()
            axis, radius = cyl.Axis(), float(cyl.Radius())
            origin, direction = axis.Location(), axis.Direction()
            axial = []
            vertices = TopExp_Explorer(face, TopAbs_VERTEX)
            while vertices.More():
                p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(vertices.Current()))
                axial.append(
                    (p.X() - origin.X()) * direction.X()
                    + (p.Y() - origin.Y()) * direction.Y()
                    + (p.Z() - origin.Z()) * direction.Z()
                )
                vertices.Next()
            result.append({
                "kind": "cylindrical_face",
                "diameter_mm": radius * 2,
                "axial_span_mm": float(max(axial) - min(axial)) if axial else 0.0,
                "axis_origin_mm": [float(origin.X()), float(origin.Y()), float(origin.Z())],
                "axis_direction": [float(direction.X()), float(direction.Y()), float(direction.Z())],
                "semantic": "hole_or_shaft_surface",
            })
        exp.Next()
    return result


def extract_drawing_model_loaded(
    loaded: LoadedStep,
    project_id: str,
    part_id: str,
    directive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options = normalize_directive(directive)
    label = find_part_label(loaded, project_id, part_id)
    shape = loaded.shape_tool.GetShape_s(label)
    views = {}
    for name, direction in VIEW_PRESETS[options["primary_view"]].items():
        edges = project_shape(shape, direction)
        if not options["show_hidden_lines"]:
            edges = [edge for edge in edges if not edge["hidden"]]
        views[name] = {
            "direction": list(direction),
            "bounds": _bounds(edges),
            "edges": edges,
        }
    return {
        "schema_version": 2,
        "project_id": project_id,
        "part_id": part_id,
        "part_name": _display_name(loaded, label),
        "units": "mm",
        "standard_profile": "GB-mechanical-baseline-v0.2",
        "drawing_options": options,
        "views": views,
        "features": _cylinders(shape),
        "release_status": "draft_requires_human_review",
    }


def extract_drawing_model(
    source_step: str | Path,
    project_id: str,
    part_id: str,
    directive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return extract_drawing_model_loaded(load_step(source_step), project_id, part_id, directive)


def _layout() -> dict[str, Any]:
    page_w, page_h = landscape(A3)
    margin, title_h = 34.0, 92.0
    usable_w, usable_h = page_w - margin * 2, page_h - margin * 2 - title_h
    cell_w = usable_w / 3
    return {
        "page": [page_w, page_h],
        "margin": margin,
        "title_h": title_h,
        "cells": {
            "front": (margin, margin + title_h, cell_w, usable_h),
            "top": (margin + cell_w, margin + title_h, cell_w, usable_h),
            "right": (margin + cell_w * 2, margin + title_h, cell_w, usable_h),
        },
    }


def _map(
    x: float,
    y: float,
    b: dict[str, float],
    cell: tuple[float, float, float, float],
) -> tuple[float, float]:
    cx, cy, cw, ch = cell
    pad, bw, bh = 48.0, max(b["width"], 1e-6), max(b["height"], 1e-6)
    scale = min((cw - 2 * pad) / bw, (ch - 2 * pad) / bh)
    ox = cx + (cw - bw * scale) / 2 - b["xmin"] * scale
    oy = cy + (ch - bh * scale) / 2 - b["ymin"] * scale
    return ox + x * scale, oy + y * scale


def _svg_tick(dwg: svgwrite.Drawing, x: float, y: float, horizontal: bool) -> Any:
    if horizontal:
        return dwg.line(start=(x - 3, y + 3), end=(x + 3, y - 3), stroke="black", stroke_width=0.8)
    return dwg.line(start=(x - 3, y - 3), end=(x + 3, y + 3), stroke="black", stroke_width=0.8)


def _svg_dimensions(
    dwg: svgwrite.Drawing,
    view: dict[str, Any],
    cell: tuple[float, float, float, float],
    page_h: float,
) -> None:
    b = view["bounds"]
    x0, y0 = _map(b["xmin"], b["ymin"], b, cell)
    x1, y1 = _map(b["xmax"], b["ymax"], b, cell)
    y0, y1 = page_h - y0, page_h - y1
    bottom = max(y0, y1) + 22
    left = min(x0, x1) - 22

    dwg.add(dwg.line(start=(x0, max(y0, y1) + 4), end=(x0, bottom + 4), stroke="black", stroke_width=0.55))
    dwg.add(dwg.line(start=(x1, max(y0, y1) + 4), end=(x1, bottom + 4), stroke="black", stroke_width=0.55))
    dwg.add(dwg.line(start=(x0, bottom), end=(x1, bottom), stroke="black", stroke_width=0.75))
    dwg.add(_svg_tick(dwg, x0, bottom, True))
    dwg.add(_svg_tick(dwg, x1, bottom, True))
    dwg.add(dwg.text(f"{b['width']:.2f}", insert=((x0 + x1) / 2 - 12, bottom - 4), font_size=8))

    top_y, bottom_y = min(y0, y1), max(y0, y1)
    dwg.add(dwg.line(start=(min(x0, x1) - 4, top_y), end=(left - 4, top_y), stroke="black", stroke_width=0.55))
    dwg.add(dwg.line(start=(min(x0, x1) - 4, bottom_y), end=(left - 4, bottom_y), stroke="black", stroke_width=0.55))
    dwg.add(dwg.line(start=(left, top_y), end=(left, bottom_y), stroke="black", stroke_width=0.75))
    dwg.add(_svg_tick(dwg, left, top_y, False))
    dwg.add(_svg_tick(dwg, left, bottom_y, False))
    dwg.add(dwg.text(
        f"{b['height']:.2f}",
        insert=(left - 6, (top_y + bottom_y) / 2 + 12),
        font_size=8,
        transform=f"rotate(-90,{left - 6},{(top_y + bottom_y) / 2 + 12})",
    ))


def render_svg(model: dict[str, Any], out_path: str | Path) -> None:
    layout = _layout()
    page_w, page_h = layout["page"]
    options = model["drawing_options"]
    dwg = svgwrite.Drawing(str(out_path), size=(page_w, page_h), viewBox=f"0 0 {page_w} {page_h}")
    dwg.add(dwg.rect(insert=(0, 0), size=(page_w, page_h), fill="white"))
    m = layout["margin"]
    dwg.add(dwg.rect(
        insert=(m, m),
        size=(page_w - 2 * m, page_h - 2 * m),
        fill="none",
        stroke="black",
        stroke_width=1.2,
    ))
    dwg.add(dwg.line(
        start=(m, m + layout["title_h"]),
        end=(page_w - m, m + layout["title_h"]),
        stroke="black",
    ))
    dwg.add(dwg.text(f"PART: {model['part_name']}", insert=(m + 8, m + 20), font_size=11))
    dwg.add(dwg.text(
        f"ID: {model['part_id']} · PRIMARY: {options['primary_view']}",
        insert=(m + 8, m + 36),
        font_size=8,
    ))
    dwg.add(dwg.text(
        "DRAFT · HUMAN REVIEW REQUIRED",
        insert=(page_w - m - 220, m + 20),
        font_size=9,
        font_weight="bold",
    ))

    note_y = m + 52
    for note in options["notes"][:3]:
        dwg.add(dwg.text(f"NOTE: {note}", insert=(m + 8, note_y), font_size=7))
        note_y += 11
    for note in options["unresolved_requests"][:2]:
        dwg.add(dwg.text(f"UNRESOLVED: {note}", insert=(page_w / 2, note_y - 11), font_size=7))

    for view_name, cell in layout["cells"].items():
        view = model["views"][view_name]
        direction = ",".join(f"{x:g}" for x in view["direction"])
        dwg.add(dwg.text(
            f"{view_name.upper()} [{direction}]",
            insert=(cell[0] + 6, page_h - (cell[1] + cell[3]) + 16),
            font_size=8,
        ))
        for edge in view["edges"]:
            pts = [_map(p[0], p[1], view["bounds"], cell) for p in edge["points"]]
            pts = [(x, page_h - y) for x, y in pts]
            line = dwg.polyline(points=pts, fill="none", stroke="#111", stroke_width=0.75)
            if edge["hidden"]:
                line.update({"stroke-dasharray": "4,3"})
            dwg.add(line)
        if options["show_overall_dimensions"]:
            _svg_dimensions(dwg, view, cell, page_h)

    if options["show_feature_table"] and model["features"]:
        x = page_w - m - 245
        y = page_h - m - 72
        dwg.add(dwg.text("CYLINDRICAL FEATURES (CAD)", insert=(x, y), font_size=7, font_weight="bold"))
        for i, feature in enumerate(model["features"][:4], start=1):
            dwg.add(dwg.text(
                f"C{i}: Ø{feature['diameter_mm']:.2f}  span {feature['axial_span_mm']:.2f} mm",
                insert=(x, y + i * 11),
                font_size=7,
            ))
    dwg.save()


def _pdf_tick(c: canvas.Canvas, x: float, y: float, horizontal: bool) -> None:
    if horizontal:
        c.line(x - 3, y - 3, x + 3, y + 3)
    else:
        c.line(x - 3, y + 3, x + 3, y - 3)


def _pdf_dimensions(
    c: canvas.Canvas,
    view: dict[str, Any],
    cell: tuple[float, float, float, float],
) -> None:
    b = view["bounds"]
    x0, y0 = _map(b["xmin"], b["ymin"], b, cell)
    x1, y1 = _map(b["xmax"], b["ymax"], b, cell)
    bottom = min(y0, y1) - 22
    left = min(x0, x1) - 22

    c.setLineWidth(0.55)
    c.line(x0, min(y0, y1) - 4, x0, bottom - 4)
    c.line(x1, min(y0, y1) - 4, x1, bottom - 4)
    c.setLineWidth(0.75)
    c.line(x0, bottom, x1, bottom)
    _pdf_tick(c, x0, bottom, True)
    _pdf_tick(c, x1, bottom, True)
    c.setFont("Helvetica", 7)
    c.drawCentredString((x0 + x1) / 2, bottom + 4, f"{b['width']:.2f}")

    top_y, bottom_y = max(y0, y1), min(y0, y1)
    c.setLineWidth(0.55)
    c.line(min(x0, x1) - 4, top_y, left - 4, top_y)
    c.line(min(x0, x1) - 4, bottom_y, left - 4, bottom_y)
    c.setLineWidth(0.75)
    c.line(left, top_y, left, bottom_y)
    _pdf_tick(c, left, top_y, False)
    _pdf_tick(c, left, bottom_y, False)
    c.saveState()
    c.translate(left - 5, (top_y + bottom_y) / 2)
    c.rotate(90)
    c.drawCentredString(0, 0, f"{b['height']:.2f}")
    c.restoreState()


def render_pdf(model: dict[str, Any], out_path: str | Path) -> None:
    layout = _layout()
    page_w, page_h = layout["page"]
    options = model["drawing_options"]
    c = canvas.Canvas(str(out_path), pagesize=(page_w, page_h))
    m = layout["margin"]
    c.rect(m, m, page_w - 2 * m, page_h - 2 * m)
    c.line(m, m + layout["title_h"], page_w - m, m + layout["title_h"])
    c.setFont("Helvetica-Bold", 10)
    c.drawString(m + 8, m + 66, f"PART: {model['part_name']}")
    c.setFont("Helvetica", 7)
    c.drawString(m + 8, m + 52, f"ID: {model['part_id']} | PRIMARY: {options['primary_view']}")
    c.setFont("Helvetica-Bold", 8)
    c.drawRightString(page_w - m - 8, m + 66, "DRAFT - HUMAN REVIEW REQUIRED")
    c.setFont("Helvetica", 6.5)
    for i, note in enumerate(options["notes"][:3]):
        c.drawString(m + 8, m + 38 - i * 10, f"NOTE: {note}"[:95])
    for i, note in enumerate(options["unresolved_requests"][:2]):
        c.drawString(page_w / 2, m + 38 - i * 10, f"UNRESOLVED: {note}"[:85])

    for view_name, cell in layout["cells"].items():
        view = model["views"][view_name]
        direction = ",".join(f"{x:g}" for x in view["direction"])
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(cell[0] + 6, cell[1] + cell[3] - 14, f"{view_name.upper()} [{direction}]")
        for edge in view["edges"]:
            pts = [_map(p[0], p[1], view["bounds"], cell) for p in edge["points"]]
            c.setDash(4, 3) if edge["hidden"] else c.setDash()
            p = c.beginPath()
            p.moveTo(*pts[0])
            for point in pts[1:]:
                p.lineTo(*point)
            c.drawPath(p, stroke=1, fill=0)
        c.setDash()
        if options["show_overall_dimensions"]:
            _pdf_dimensions(c, view, cell)

    if options["show_feature_table"] and model["features"]:
        c.setFont("Helvetica-Bold", 6.5)
        c.drawRightString(page_w - m - 8, m + 38, "CYLINDRICAL FEATURES (CAD)")
        c.setFont("Helvetica", 6.5)
        for i, feature in enumerate(model["features"][:4], start=1):
            c.drawRightString(
                page_w - m - 8,
                m + 38 - i * 10,
                f"C{i}: D{feature['diameter_mm']:.2f} span {feature['axial_span_mm']:.2f} mm",
            )
    c.save()


def _dxf_polyline(points: list[list[float]], layer: str) -> str:
    rows = ["0", "LWPOLYLINE", "8", layer, "90", str(len(points)), "70", "0"]
    for x, y in points:
        rows.extend(["10", f"{x:.6f}", "20", f"{y:.6f}"])
    return "\n".join(rows) + "\n"


def _dxf_text(x: float, y: float, text: str, layer: str = "ANNOTATION") -> str:
    safe = text.encode("ascii", errors="replace").decode("ascii")
    return "\n".join([
        "0", "TEXT", "8", layer, "10", f"{x:.6f}", "20", f"{y:.6f}",
        "40", "4.0", "1", safe,
    ]) + "\n"


def render_dxf(model: dict[str, Any], out_path: str | Path) -> None:
    chunks = ["0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"]
    xoffset = 0.0
    options = model["drawing_options"]
    for view_name in ("front", "top", "right"):
        view, b = model["views"][view_name], model["views"][view_name]["bounds"]
        for edge in view["edges"]:
            pts = [[p[0] - b["xmin"] + xoffset, p[1] - b["ymin"]] for p in edge["points"]]
            chunks.append(_dxf_polyline(pts, "HIDDEN" if edge["hidden"] else "VISIBLE"))
        if options["show_overall_dimensions"]:
            chunks.append(_dxf_text(xoffset + b["width"] / 2, -12, f"{b['width']:.2f} mm"))
            chunks.append(_dxf_text(xoffset - 20, b["height"] / 2, f"{b['height']:.2f} mm"))
        xoffset += b["width"] + 80
    for i, note in enumerate(options["notes"][:4]):
        chunks.append(_dxf_text(0, -30 - i * 8, f"NOTE: {note}"))
    chunks.append("0\nENDSEC\n0\nEOF\n")
    Path(out_path).write_text("".join(chunks), encoding="ascii")


def generate_drawing_bundle_loaded(
    loaded: LoadedStep,
    project_id: str,
    part_id: str,
    out_dir: str | Path,
    revision: int = 0,
    directive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = extract_drawing_model_loaded(loaded, project_id, part_id, directive)
    model["revision"] = revision
    paths = {
        "json": out_dir / "drawing.json",
        "svg": out_dir / "drawing.svg",
        "pdf": out_dir / "drawing.pdf",
        "dxf": out_dir / "drawing.dxf",
    }
    paths["json"].write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    render_svg(model, paths["svg"])
    render_pdf(model, paths["pdf"])
    render_dxf(model, paths["dxf"])
    return {
        "part_id": part_id,
        "part_name": model["part_name"],
        "revision": revision,
        "drawing_options": model["drawing_options"],
        "features": model["features"],
        "artifacts": {k: str(v) for k, v in paths.items()},
    }


def generate_drawing_bundle(
    source_step: str | Path,
    project_id: str,
    part_id: str,
    out_dir: str | Path,
    revision: int = 0,
    directive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return generate_drawing_bundle_loaded(
        load_step(source_step),
        project_id,
        part_id,
        out_dir,
        revision,
        directive,
    )
