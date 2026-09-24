# Machine-Part

Web-based CAD decomposition, engineering drawing, costing and quotation pipeline.

## Status

- **Stage 1 — implemented baseline:** upload STEP/STP, parse XCAF assembly tree, extract part geometry metadata, generate GLB, render in web UI, select/highlight parts.
- **ZIP/native CAD ingestion — adapter skeleton:** ZIP candidate detection exists. Native SolidWorks (`.SLDASM/.SLDPRT`) is intentionally not treated as directly parseable; a conversion adapter is required.
- **Stage 2 — orchestration started:** MiniMax M3 creates manufacturing/drawing intent from CAD-kernel facts. Deterministic orthographic projection, GB dimension placement, PDF/DXF export and human revision loop are release-gated and not yet implemented.
- **Stage 3 — planned:** machining-time/material costing, BOM and commercial documents.

See `docs/PRD.md`, `docs/ARCHITECTURE.md` and `docs/TEST_REPORT_ASM_5015.md`.

## Architecture

- **Cloudflare Worker:** API gateway and static web application.
- **Cloudflare R2:** original CAD, GLB, drawings, BOM and quotation artifacts.
- **Cloudflare D1:** project state and artifact pointers.
- **Cloudflare Workflows:** durable stage orchestration, retries and future human-in-the-loop gates.
- **Cloudflare Containers:** Linux CAD compute using OpenCascade/CadQuery.
- **MiniMax M3:** classification, drawing intent, review-instruction interpretation and commercial reasoning. Geometry/dimensions remain CAD-kernel facts.

## Quick start

Prerequisites: Node.js 22+, Docker, Cloudflare Workers Paid plan, R2, D1, and a MiniMax Token Plan subscription key.

```bash
npm install
npx wrangler d1 create machine-part
# Replace D1 database_id in wrangler.jsonc
npx wrangler r2 bucket create machine-part-artifacts
npx wrangler secret put MINIMAX_API_KEY
npx wrangler d1 execute machine-part --remote --file=migrations/0001_init.sql
npm run deploy
```

Local CAD regression test:

```bash
cd services/cad
PYTHONPATH=. MACHINE_PART_SAMPLE_STEP=/path/to/sample.step pytest -q
```

## Design rule

The LLM may decide *what should be documented* and interpret reviewer language. It must not invent numeric CAD geometry. Numeric dimensions, projections, mass properties and feature geometry must come from OpenCascade or validated process data.
