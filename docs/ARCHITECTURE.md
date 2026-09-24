# Architecture v0.1

## System boundary

```text
Browser
  | HTTPS
Cloudflare Worker + Static Assets
  |-- D1 (project state)
  |-- R2 (CAD/artifacts)
  |-- MiniMax M3 API
  |-- Cloudflare Workflow
        |-- CadContainer (OpenCascade/CadQuery)
        |-- future drawing approval waitForEvent()
        |-- future costing/document generation
```

## Why the CAD kernel is in a Container

A normal Worker isolate has a 128 MB memory limit. OpenCascade tessellation and STEP/XCAF workloads can exceed that, and native Python wheels are not suitable for a Pyodide-only runtime. Cloudflare Containers keep the system inside the Cloudflare deployment model while providing Linux, filesystem, native libraries, CPU and GB-scale memory.

## Storage model

R2 keys:

```text
projects/{projectId}/source/{originalName}
projects/{projectId}/stage1/manifest.json
projects/{projectId}/stage1/assembly.glb
projects/{projectId}/stage2/{partId}/r{revision}/drawing.json
projects/{projectId}/stage2/{partId}/r{revision}/drawing.svg
projects/{projectId}/stage2/{partId}/r{revision}/drawing.pdf
projects/{projectId}/stage2/{partId}/r{revision}/drawing.dxf
projects/{projectId}/stage3/r{revision}/bom.xlsx
projects/{projectId}/stage3/r{revision}/quotation.pdf
```

## Stage 1 data contract

Each leaf part has a stable project-scoped ID derived from the XCAF label entry. Name is presentation metadata and is not used as the primary key because CAD files may contain duplicate names.

Manifest fields:
- ID and XCAF label entries;
- name and parent;
- kind: assembly/part;
- child IDs;
- bounding box in mm;
- exact volume and surface area when meaningful;
- center of mass;
- artifact metadata.

GLB is emitted by OCCT `RWGltf_CafWriter` after B-Rep triangulation. Faces are merged per part so the web viewer can highlight a logical part rather than hundreds of individual faces.

## MiniMax M3 policy

The application uses the OpenAI-compatible MiniMax endpoint with `MiniMax-M3`. The subscription key is stored as a Worker secret and never sent to the browser.

Allowed AI tasks:
- purchased-vs-machined classification;
- drawing/view intent;
- datum/dimension priority suggestions;
- parsing reviewer text into structured edit commands;
- process-routing suggestions;
- quotation wording.

Disallowed as authoritative truth:
- invented dimensions;
- invented tolerances/materials;
- invented machining time without a model/assumption ledger.

## Native SolidWorks

`.SLDASM/.SLDPRT` are proprietary. ZIP upload and assembly candidate selection are part of the UX, but production support requires a conversion adapter. Recommended adapter interface:

```text
POST /convert
input: archive + root assembly path
output: STEP AP242/AP214 + mapping.json
```

Commercial conversion engines can be added without changing the rest of the pipeline. V1 directly supports STEP/STP.

## Security

- Validate file type from content and extension.
- Set per-project upload size quotas.
- Stream large bodies; never buffer entire CAD files in Worker memory.
- Keep MiniMax subscription key in Worker secrets.
- Use randomized project IDs and authorization before production multi-user launch.
- Sanitize archive paths to prevent Zip Slip.
- Container outbound network disabled by default.
