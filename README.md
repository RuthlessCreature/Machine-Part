# Machine-Part

Web-based CAD decomposition, engineering-drawing, costing and quotation pipeline built on Cloudflare.

## Current status

### Stage 1 — implemented and regression-tested

- Selecting a STEP/STP file immediately creates the project, uploads the source and starts Stage 1 in the background; the 3D GLB appears automatically as soon as it is ready.
- Upload STEP/STP directly.
- Upload ZIP and select the root CAD candidate in the web UI.
- ZIP-contained STEP/STP can continue directly.
- Native SolidWorks (`.SLDASM/.SLDPRT`) is detected and explicitly stopped at a converter-adapter gate; unsupported proprietary geometry is never fabricated.
- OpenCascade XCAF assembly parsing with stable project-scoped part IDs.
- Exact B-Rep properties: bounding box, volume, surface area and center of mass.
- Per-part GLB meshes for browser rendering and unambiguous click/highlight behavior.

### Stage 2 — deterministic draft workflow implemented

- Select one or many parts.
- Hidden-line orthographic projections from OpenCascade.
- Overall dimensions derived from CAD geometry.
- Cylindrical feature extraction and CAD-derived diameter/span table.
- SVG, PDF, DXF and machine-readable JSON artifacts.
- MiniMax M3 converts natural-language review instructions into a strict renderer whitelist.
- Safe automatic edits: primary-view direction, hidden-line visibility, overall-dimension visibility, cylindrical-feature table and plain notes.
- Per-drawing human review and immutable revisions; editing one drawing preserves all unaffected drawings.
- Unsupported or unprovable requests are recorded as `unresolved_requests`, not hallucinated.

This is a **manufacturing drawing draft baseline**, not yet a claim of fully autonomous production release. Full GB conformity still requires the remaining title-block, GD&T, surface-texture, thread/PMI, welding and industry-specific rules plus human validation.

### Stage 3 — auditable preliminary costing implemented

- Deterministic costing from CAD volume + explicit material/process/commercial policy.
- Material, setup, removal time, inspection, tooling, scrap/risk and margin kept as separate terms.
- Missing material price does not get guessed: `quote_complete=false`.
- Outputs: `costing.json`, `BOM.xlsx`, `BOM.csv`, `quotation.pdf`.
- Stage 3 can cost a subset of Stage 2 drawings without deleting or regenerating the rest.

### One-click mode

`targetStage=1|2|3` drives the same Cloudflare Workflow. A free-text instruction is interpreted by MiniMax M3 only within controlled schemas; geometry and numeric CAD facts remain deterministic.

## Architecture

- **Cloudflare Worker:** API gateway and static web application.
- **Cloudflare R2:** original CAD and immutable artifacts.
- **Cloudflare D1:** project state and current artifact pointers.
- **Cloudflare Workflows:** durable multi-stage orchestration.
- **Cloudflare Containers:** Linux OpenCascade/CadQuery geometry service.
- **MiniMax M3 Token Plan:** classification, controlled drawing intent, review interpretation and costing-policy extraction.
- **React + Three.js:** web workbench.

See `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/GB_DRAWING_RULES.md`, `docs/TEST_REPORT_ASM_5015.md` and `docs/DEPLOYMENT.md`.

## Production target

The committed Wrangler configuration contains the Cloudflare Custom Domain:

```json
"routes": [
  { "pattern": "ikun.homes", "custom_domain": true }
]
```

The manual `Deploy Cloudflare` GitHub Action creates/reuses the D1 database and R2 bucket, applies migrations, deploys the Worker + Container, installs the MiniMax secret and verifies `https://ikun.homes/api/health`.

Required repository secrets are documented in `docs/DEPLOYMENT.md`.

## Local validation

```bash
npm install
npm run build:web
npm --workspace apps/worker run typecheck

pip install -r services/cad/requirements.txt pytest
PYTHONPATH=services/cad pytest -q services/cad/tests
```

Optional regression against the supplied production-like STEP:

```bash
PYTHONPATH=services/cad \
MACHINE_PART_SAMPLE_STEP=/path/to/ASM_5015_CONCEPT.step \
pytest -q services/cad/tests
```

## Core design rule

The LLM may decide **what to document** and translate human intent into controlled operations. It must not invent CAD geometry, dimensions, tolerances, material prices, process rates or PMI. Numeric geometry comes from OpenCascade; commercial values come from explicit policies or validated data sources.
