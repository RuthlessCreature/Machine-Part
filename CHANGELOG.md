# Changelog

## 0.3.0 — 2026-09-24

- Added safe ZIP CAD discovery, root-candidate selection API and web UI.
- Added Zip Slip path validation.
- Native SolidWorks candidates now stop explicitly at a converter-adapter gate.
- Added deterministic Stage 2 HLR orthographic drawing engine.
- Added CAD-derived overall dimensions and cylindrical feature table.
- Added SVG/PDF/DXF/JSON engineering drawing outputs.
- Added MiniMax M3 renderer-whitelist directives and real per-sheet revision rendering.
- Added `unresolved_requests` for review instructions that cannot be proven from CAD.
- Added revision inheritance so editing one drawing does not remove unaffected drawings.
- Added deterministic Stage 3 material/process/commercial costing with assumptions ledger.
- Added BOM XLSX/CSV and preliminary quotation PDF.
- Added subset costing without shrinking the Stage 2 drawing set.
- Added Cloudflare production deployment workflow and `ikun.homes` Custom Domain configuration.
- Switched MiniMax integration to the official M3 chat endpoint.
- Added Worker typecheck, drawing revision, costing and ZIP regressions.

## 0.1.0 — 2026-09-24

- Initialized Cloudflare Worker/Workflows/R2/D1/Containers architecture.
- Added OpenCascade STEP/XCAF ingest service.
- Added assembly manifest with stable part IDs and exact geometry properties.
- Added merged-per-part GLB export.
- Added React/Three.js web workbench with upload, 3D viewer and part selection/highlighting.
- Added MiniMax M3 adapter and token-plan quota endpoint.
- Added one-click workflow contract.
- Added regression report for uploaded `ASM_5015_CONCEPT` sample.
