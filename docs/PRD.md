# Machine-Part PRD v0.1

## 1. Background

The product converts an uploaded machine/assembly CAD model into a structured manufacturing workflow: assembly decomposition, selectable parts, engineering drawings, human review and AI-assisted revision, machining/material costing, BOM and quotation documents.

## 2. Goals

1. Browser-based operation with Cloudflare as the primary application platform.
2. Accept STEP/STP immediately; support archive-based assembly selection; add native CAD conversion through explicit adapters.
3. Preserve assembly/part identity and provide 3D selection/highlighting.
4. Generate production-oriented 2D drawings from deterministic geometry and apply current GB drawing rules.
5. Allow a reviewer to comment on each drawing and regenerate only the affected drawing/revision.
6. Estimate material and process time with auditable assumptions.
7. Generate BOM and commercial quotation artifacts.
8. Provide a one-click mode that can run to a requested stage and apply a free-text instruction as a controlled override.

## 3. Non-goals

- Treating an LLM as a geometry kernel.
- Claiming lossless native SolidWorks parsing without a licensed/validated converter.
- Inferring tolerances, roughness, material or heat treatment as factual when they are absent from source data.
- Auto-releasing production drawings without a configurable human approval gate.

## 4. Stages

### Stage 1 — CAD ingestion and part selection

Input: STEP/STP or archive. Output: source artifact, assembly manifest, GLB, part list and stable part IDs.

Acceptance:
- Assembly hierarchy survives parsing.
- Leaf parts are individually selectable.
- Clicking the list highlights the corresponding 3D part; clicking 3D selects the list item.
- Part metadata includes bounding box, volume, surface area and center of mass where valid.
- No model-generated dimensions are used.

### Stage 2 — drawing generation and review

Input: selected part IDs plus optional user instruction. Output per part: drawing source JSON, SVG/PDF preview, DXF, review state and revision history.

Required engine sequence:
1. Extract exact B-Rep for the selected part.
2. Detect manufacturing-relevant features: planar faces, cylinders/holes, slots, pockets, chamfers, fillets and datum candidates.
3. Choose views and section views.
4. Generate hidden-line projections.
5. Generate dimension candidates from exact geometry.
6. Use M3 only to rank/organize dimension intent and translate natural-language reviewer comments into structured edit operations.
7. Validate every numeric dimension against source geometry.
8. Layout annotations according to configured GB rules.
9. Render preview/export.
10. Human approval/revision.

### Stage 3 — costing and commercial output

Input: approved drawings + source 3D + material/process policy. Output: routing estimate, material cost, setup/run time, BOM, quotation and assumptions ledger.

Cost model must separate:
- raw material and buy-to-fly ratio;
- cutting/preparation;
- machine setup;
- cycle time by operation;
- tooling/consumables;
- outside process;
- inspection;
- scrap/risk factor;
- overhead and margin.

## 5. One-click mode

Parameters:
- `targetStage`: 1/2/3;
- optional selected parts; empty means classify all leaf parts;
- `instruction`: free text, parsed into structured overrides;
- approval policy: `auto_draft`, `require_drawing_approval`, `require_quote_approval`.

The workflow must be resumable and idempotent. Each stage writes immutable revisioned artifacts and updates a project pointer only after validation succeeds.

## 6. Failure conditions

- CAD parser reports no shape/root assembly.
- Part count or topology changes unexpectedly between revisions without user acknowledgement.
- Generated dimension does not validate against exact geometry.
- Drawing contains overlapping/unreadable annotations beyond configured threshold.
- Costing lacks material/process assumptions.
- MiniMax returns non-parseable output after bounded retries.

## 7. Rollback

Artifacts are revisioned in R2. D1 stores current pointers. Rollback changes pointers to a prior validated revision; source uploads are never overwritten in place.
