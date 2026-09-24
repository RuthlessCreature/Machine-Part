import { getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { minimaxJson } from "./minimax";
import type { Env, PipelineParams, ProjectRow } from "./types";

async function project(env: Env, id: string): Promise<ProjectRow> {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(id).first<ProjectRow>();
  if (!row) throw new Error(`Project not found: ${id}`);
  return row;
}

async function patchStatus(env: Env, id: string, status: string, stage: number, error: string | null = null) {
  await env.DB.prepare(
    "UPDATE projects SET status=?, current_stage=?, last_error=?, updated_at=datetime('now') WHERE id=?"
  ).bind(status, stage, error, id).run();
}

function contentType(format: string): string {
  return ({
    json: "application/json",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    dxf: "application/dxf"
  } as Record<string, string>)[format] || "application/octet-stream";
}

function artifactUrl(projectId: string, relativePath: string): string {
  const safe = relativePath.split("/").map(encodeURIComponent).join("/");
  return `http://cad/v1/jobs/${projectId}/artifacts/${safe}`;
}

export class CadPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { projectId, targetStage, selectedPartIds, instruction } = event.payload;
    const revision = Math.max(0, Number(event.payload.revision ?? 0));

    try {
      const p = await step.do("load-project", () => project(this.env, projectId));
      if (!p.source_key || !p.source_name) throw new Error("Project has no uploaded source");

      await step.do("mark-ingesting", () => patchStatus(this.env, projectId, "ingesting", 0));

      const ingest = await step.do("cad-ingest", async () => {
        const source = await this.env.BUCKET.get(p.source_key!);
        if (!source?.body) throw new Error("Source object missing from R2");
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(new Request(`http://cad/v1/jobs/${projectId}/ingest`, {
          method: "POST",
          headers: { "x-filename": p.source_name! },
          body: source.body
        }));
        const text = await response.text();
        if (!response.ok) throw new Error(`CAD ingest ${response.status}: ${text}`);
        return JSON.parse(text);
      });

      if (ingest.status === "assembly_selection_required" || ingest.status === "converter_required") {
        const key = `projects/${projectId}/assembly-candidates.json`;
        await step.do("save-candidates", () => this.env.BUCKET.put(key, JSON.stringify(ingest), {
          httpMetadata: { contentType: "application/json" }
        }));
        await step.do("wait-selection", () => patchStatus(this.env, projectId, "assembly_selection_required", 0));
        return { status: ingest.status, candidatesKey: key };
      }

      const manifestKey = `projects/${projectId}/stage1/manifest.json`;
      const glbKey = `projects/${projectId}/stage1/assembly.glb`;

      await step.do("save-stage1-artifacts", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const [manifestResponse, glbResponse] = await Promise.all([
          container.fetch(`http://cad/v1/jobs/${projectId}/manifest`),
          container.fetch(`http://cad/v1/jobs/${projectId}/artifacts/assembly.glb`)
        ]);
        if (!manifestResponse.ok || !manifestResponse.body) {
          throw new Error(`Manifest fetch failed: ${manifestResponse.status}`);
        }
        if (!glbResponse.ok || !glbResponse.body) {
          throw new Error(`GLB fetch failed: ${glbResponse.status}`);
        }
        await Promise.all([
          this.env.BUCKET.put(manifestKey, manifestResponse.body, { httpMetadata: { contentType: "application/json" } }),
          this.env.BUCKET.put(glbKey, glbResponse.body, { httpMetadata: { contentType: "model/gltf-binary" } })
        ]);
      });

      await step.do("commit-stage1", async () => {
        await this.env.DB.prepare(
          "UPDATE projects SET status='stage1_ready', current_stage=1, manifest_key=?, glb_key=?, updated_at=datetime('now') WHERE id=?"
        ).bind(manifestKey, glbKey, projectId).run();
      });

      if (targetStage === 1) return { status: "stage1_ready", manifestKey, glbKey };

      const selection = await step.do("prepare-stage2-selection", async () => {
        const manifestObject = await this.env.BUCKET.get(manifestKey);
        if (!manifestObject) throw new Error("Stage 1 manifest missing from R2");
        const manifest = JSON.parse(await manifestObject.text());
        const parts = (manifest.nodes ?? []).filter((n: any) => n.kind === "part");
        const chosen = selectedPartIds?.length
          ? parts.filter((part: any) => selectedPartIds.includes(part.id))
          : parts;
        if (!chosen.length) throw new Error("No valid parts selected for Stage 2");
        return { parts, chosen };
      });

      await step.do("mark-stage2-generating", () => patchStatus(this.env, projectId, "stage2_generating", 1));

      const plan = await step.do("stage2-ai-plan", async () => {
        return minimaxJson<any>(this.env, {
          system: [
            "You are a manufacturing drawing planner. Return JSON only.",
            "Never invent numeric geometry. CAD-kernel values are ground truth.",
            "Classify each supplied part as machined, fabricated/sheet, purchased/standard, or unknown.",
            "Propose view strategy, datum intent, dimension intent, tolerances that require human confirmation, and manufacturing notes.",
            "If the user supplied revision feedback, translate it into structured drawing edit intent.",
            "Use concise Chinese notes."
          ].join(" "),
          user: JSON.stringify({
            instruction: instruction ?? "",
            revision,
            parts: selection.chosen.slice(0, 500)
          })
        });
      });

      const planKey = `projects/${projectId}/stage2/r${revision}/drawing-plan.json`;
      await step.do("save-stage2-plan", () => this.env.BUCKET.put(planKey, JSON.stringify(plan), {
        httpMetadata: { contentType: "application/json" }
      }));

      const drawingIndex = await step.do("generate-stage2-drawings", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(new Request(`http://cad/v1/jobs/${projectId}/draw`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            part_ids: selection.chosen.map((part: any) => part.id),
            revision
          })
        }));
        const body = await response.text();
        if (!response.ok) throw new Error(`Drawing generation ${response.status}: ${body}`);
        return JSON.parse(body);
      });

      const drawingIndexKey = `projects/${projectId}/stage2/r${revision}/drawing-index.json`;
      const persistedIndex = await step.do("persist-stage2-artifacts", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const normalized = { ...drawingIndex, drawings: [] as any[] };

        for (const drawing of drawingIndex.drawings ?? []) {
          const savedArtifacts: Record<string, string> = {};
          await Promise.all(Object.entries(drawing.artifacts ?? {}).map(async ([format, relative]) => {
            const response = await container.fetch(artifactUrl(projectId, String(relative)));
            if (!response.ok || !response.body) {
              throw new Error(`Drawing artifact fetch failed: ${relative} (${response.status})`);
            }
            const key = `projects/${projectId}/stage2/${drawing.part_id}/r${revision}/drawing.${format}`;
            await this.env.BUCKET.put(key, response.body, {
              httpMetadata: { contentType: contentType(format) }
            });
            savedArtifacts[format] = key;
          }));
          normalized.drawings.push({ ...drawing, artifacts: savedArtifacts });
        }

        await this.env.BUCKET.put(drawingIndexKey, JSON.stringify(normalized), {
          httpMetadata: { contentType: "application/json" }
        });
        return normalized;
      });

      await step.do("commit-stage2", async () => {
        await this.env.DB.prepare(
          "UPDATE projects SET status='stage2_draft_ready', current_stage=2, current_revision=?, drawing_plan_key=?, drawing_index_key=?, updated_at=datetime('now') WHERE id=?"
        ).bind(revision, planKey, drawingIndexKey, projectId).run();
      });

      if (targetStage === 2) {
        return {
          status: "stage2_draft_ready",
          stage1: { manifestKey, glbKey },
          stage2: { revision, planKey, drawingIndexKey, count: persistedIndex.count }
        };
      }

      return {
        status: "stage2_draft_ready",
        stage1: { manifestKey, glbKey },
        stage2: { revision, planKey, drawingIndexKey, count: persistedIndex.count },
        blockedAt: "stage3-costing-engine"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existing = await project(this.env, event.payload.projectId).catch(() => null);
      await patchStatus(this.env, event.payload.projectId, "failed", existing?.current_stage ?? 0, message);
      throw error;
    }
  }
}
