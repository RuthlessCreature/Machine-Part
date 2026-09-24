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

export class CadPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { projectId, targetStage, selectedPartIds, instruction } = event.payload;
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
      await step.do("save-manifest", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(`http://cad/v1/jobs/${projectId}/manifest`);
        if (!response.ok || !response.body) throw new Error(`Manifest fetch failed: ${response.status}`);
        await this.env.BUCKET.put(manifestKey, response.body, { httpMetadata: { contentType: "application/json" } });
      });
      await step.do("save-glb", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(`http://cad/v1/jobs/${projectId}/artifacts/assembly.glb`);
        if (!response.ok || !response.body) throw new Error(`GLB fetch failed: ${response.status}`);
        await this.env.BUCKET.put(glbKey, response.body, { httpMetadata: { contentType: "model/gltf-binary" } });
      });
      await step.do("commit-stage1", async () => {
        await this.env.DB.prepare(
          "UPDATE projects SET status='stage1_ready', current_stage=1, manifest_key=?, glb_key=?, updated_at=datetime('now') WHERE id=?"
        ).bind(manifestKey, glbKey, projectId).run();
      });

      if (targetStage === 1) return { status: "stage1_ready", manifestKey, glbKey };

      const plan = await step.do("stage2-ai-plan", async () => {
        const manifestObject = await this.env.BUCKET.get(manifestKey);
        if (!manifestObject) throw new Error("Stage 1 manifest missing from R2");
        const manifest = JSON.parse(await manifestObject.text());
        const parts = (manifest.nodes ?? []).filter((n: any) => n.kind === "part");
        const chosen = selectedPartIds?.length ? parts.filter((p: any) => selectedPartIds.includes(p.id)) : parts;
        return minimaxJson<any>(this.env, {
          system: [
            "You are a manufacturing drawing planner. Return JSON only.",
            "Never invent dimensions. Geometry values supplied by the CAD kernel are ground truth.",
            "Classify each part as machined, fabricated/sheet, purchased/standard, or unknown.",
            "For machined/fabricated parts propose view strategy and dimension intent, not numeric dimensions.",
            "Use concise Chinese notes."
          ].join(" "),
          user: JSON.stringify({ instruction: instruction ?? "", parts: chosen.slice(0, 250) })
        });
      });
      const planKey = `projects/${projectId}/stage2/drawing-plan.json`;
      await step.do("save-stage2-plan", () => this.env.BUCKET.put(planKey, JSON.stringify(plan), {
        httpMetadata: { contentType: "application/json" }
      }));
      await step.do("mark-stage2-planned", () => patchStatus(this.env, projectId, "stage2_planned", 1));

      return {
        status: "stage2_planned",
        stage1: { manifestKey, glbKey },
        stage2: { planKey },
        blockedAt: "deterministic-drawing-engine"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await patchStatus(this.env, event.payload.projectId, "failed", 0, message);
      throw error;
    }
  }
}
