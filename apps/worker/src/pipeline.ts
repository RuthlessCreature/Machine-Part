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
    dxf: "application/dxf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv; charset=utf-8"
  } as Record<string, string>)[format] || "application/octet-stream";
}

function artifactUrl(projectId: string, relativePath: string): string {
  const safe = relativePath.split("/").map(encodeURIComponent).join("/");
  return `http://cad/v1/jobs/${projectId}/artifacts/${safe}`;
}

export class CadPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { projectId, targetStage, selectedPartIds, instruction, assemblyCandidate } = event.payload;
    const requestedRevision = Math.max(0, Number(event.payload.revision ?? 0));

    try {
      const p = await step.do("load-project", () => project(this.env, projectId));
      if (!p.source_key || !p.source_name) throw new Error("Project has no uploaded source");

      // The CAD container filesystem is ephemeral, so every workflow invocation reloads
      // the source into the same project-scoped container before geometry work.
      await step.do("mark-ingesting", () => patchStatus(this.env, projectId, "ingesting", Math.min(p.current_stage, 1)));

      const ingest = await step.do("cad-ingest", async () => {
        const source = await this.env.BUCKET.get(p.source_key!);
        if (!source?.body) throw new Error("Source object missing from R2");
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(new Request(`http://cad/v1/jobs/${projectId}/ingest`, {
          method: "POST",
          headers: {
            "x-filename": p.source_name!,
            ...(assemblyCandidate ? { "x-assembly-candidate": assemblyCandidate } : {})
          },
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
        const projectStatus = ingest.status === "converter_required"
          ? "converter_required"
          : "assembly_selection_required";
        await step.do("wait-selection-or-converter", () => patchStatus(this.env, projectId, projectStatus, 0));
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
          "UPDATE projects SET status='stage1_ready', current_stage=MAX(current_stage,1), manifest_key=?, glb_key=?, updated_at=datetime('now') WHERE id=?"
        ).bind(manifestKey, glbKey, projectId).run();
      });

      if (targetStage === 1) return { status: "stage1_ready", manifestKey, glbKey };

      const selection = await step.do("prepare-part-selection", async () => {
        const manifestObject = await this.env.BUCKET.get(manifestKey);
        if (!manifestObject) throw new Error("Stage 1 manifest missing from R2");
        const manifest = JSON.parse(await manifestObject.text());
        const parts = (manifest.nodes ?? []).filter((n: any) => n.kind === "part");
        const chosen = selectedPartIds?.length
          ? parts.filter((part: any) => selectedPartIds.includes(part.id))
          : parts;
        if (!chosen.length) throw new Error("No valid parts selected");
        return { parts, chosen };
      });

      // Stage 3 started from an existing Stage 2 draft must NOT regenerate or shrink the
      // drawing index. The selectedPartIds in that case are only the parts to cost.
      const reuseExistingStage2 =
        targetStage === 3 &&
        p.current_stage >= 2 &&
        Boolean(p.drawing_index_key);

      let revision = requestedRevision;
      let planKey = p.drawing_plan_key ?? "";
      let drawingIndexKey = p.drawing_index_key ?? "";
      let persistedIndex: any = null;

      if (reuseExistingStage2) {
        revision = p.current_revision;
        persistedIndex = await step.do("reuse-stage2-index", async () => {
          const obj = await this.env.BUCKET.get(p.drawing_index_key!);
          if (!obj) throw new Error("Existing Stage 2 drawing index is missing from R2");
          return JSON.parse(await obj.text());
        });
      } else {
        await step.do("mark-stage2-generating", () => patchStatus(this.env, projectId, "stage2_generating", 1));

        const plan = await step.do("stage2-ai-plan", async () => {
          return minimaxJson<any>(this.env, {
            system: [
              "You are a manufacturing drawing planner. Return JSON only.",
              "Never invent numeric geometry. CAD-kernel values are ground truth.",
              "For each supplied part return exactly one object in parts[].",
              "Schema: {parts:[{part_id,classification,drawing:{primary_view,show_hidden_lines,show_overall_dimensions,show_feature_table,notes,unresolved_requests}}]}.",
              "primary_view must be one of +X,-X,+Y,-Y,+Z,-Z.",
              "Never invent numeric geometry, tolerances, thread callouts, material, or PMI. CAD-kernel values are ground truth.",
              "If a reviewer asks for a change the renderer cannot safely infer from CAD, put that request in unresolved_requests instead of pretending it was applied.",
              "Allowed automatic drawing edits are only primary view direction, hidden-line visibility, overall-dimension visibility, cylindrical-feature-table visibility, and plain notes.",
              "Use concise Chinese notes."
            ].join(" "),
            user: JSON.stringify({
              instruction: instruction ?? "",
              revision,
              parts: selection.chosen.slice(0, 500)
            })
          });
        });

        planKey = `projects/${projectId}/stage2/r${revision}/drawing-plan.json`;
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
              revision,
              drawing_plan: plan
            })
          }));
          const body = await response.text();
          if (!response.ok) throw new Error(`Drawing generation ${response.status}: ${body}`);
          return JSON.parse(body);
        });

        drawingIndexKey = `projects/${projectId}/stage2/r${revision}/drawing-index.json`;
        persistedIndex = await step.do("persist-stage2-artifacts", async () => {
          const container = getContainer(this.env.CAD_CONTAINER, projectId);
          const inherited: any[] = [];
          if (revision > 0 && p.drawing_index_key) {
            const previous = await this.env.BUCKET.get(p.drawing_index_key);
            if (previous) {
              const previousIndex = JSON.parse(await previous.text());
              inherited.push(...(previousIndex.drawings ?? []));
            }
          }
          const byPart = new Map<string, any>(inherited.map((item: any) => [item.part_id, item]));

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
            byPart.set(drawing.part_id, { ...drawing, revision, artifacts: savedArtifacts });
          }

          const normalized = {
            ...drawingIndex,
            revision,
            count: byPart.size,
            drawings: Array.from(byPart.values())
          };
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
      }

      if (targetStage === 2) {
        return {
          status: "stage2_draft_ready",
          stage1: { manifestKey, glbKey },
          stage2: { revision, planKey, drawingIndexKey, count: persistedIndex?.count ?? 0 }
        };
      }

      await step.do("mark-stage3-generating", () => patchStatus(this.env, projectId, "stage3_generating", 2));

      const costPolicy = await step.do("stage3-ai-policy", async () => {
        return minimaxJson<any>(this.env, {
          system: [
            "Return JSON only. Extract costing overrides from the user's instruction.",
            "Never invent market prices, material prices, machine rates, quantities, or margins.",
            "Use null for values the user did not state. Percentages must be decimal fractions, e.g. 25% => 0.25.",
            "Material density may be null; the deterministic costing engine has a small verified material-density catalog.",
            "Schema: {currency, material:{name,density_g_cm3,price_per_kg}, process:{stock_factor,machine_rate_per_hour,setup_minutes,removal_rate_cm3_min,inspection_minutes,tooling_pct,scrap_pct}, commercial:{gross_margin_pct}, assumptions:[]}"
          ].join(" "),
          user: instruction ?? ""
        });
      });

      const costResult = await step.do("stage3-costing", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        const response = await container.fetch(new Request(`http://cad/v1/jobs/${projectId}/cost`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            part_ids: selection.chosen.map((part: any) => part.id),
            revision,
            policy: costPolicy
          })
        }));
        const body = await response.text();
        if (!response.ok) throw new Error(`Costing generation ${response.status}: ${body}`);
        return JSON.parse(body);
      });

      const stage3Keys: Record<string, string> = {};
      await step.do("persist-stage3-artifacts", async () => {
        const container = getContainer(this.env.CAD_CONTAINER, projectId);
        await Promise.all(Object.entries(costResult.artifacts ?? {}).map(async ([format, relative]) => {
          const response = await container.fetch(artifactUrl(projectId, String(relative)));
          if (!response.ok || !response.body) {
            throw new Error(`Stage 3 artifact fetch failed: ${relative} (${response.status})`);
          }
          const filename = format === "json" ? "costing.json"
            : format === "xlsx" ? "bom.xlsx"
            : format === "csv" ? "bom.csv"
            : "quotation.pdf";
          const key = `projects/${projectId}/stage3/r${revision}/${filename}`;
          await this.env.BUCKET.put(key, response.body, {
            httpMetadata: { contentType: contentType(format) }
          });
          stage3Keys[format] = key;
        }));
      });

      await step.do("commit-stage3", async () => {
        await this.env.DB.prepare(
          "UPDATE projects SET status='stage3_ready', current_stage=3, costing_key=?, bom_key=?, quotation_key=?, updated_at=datetime('now') WHERE id=?"
        ).bind(stage3Keys.json ?? null, stage3Keys.xlsx ?? null, stage3Keys.pdf ?? null, projectId).run();
      });

      return {
        status: "stage3_ready",
        stage1: { manifestKey, glbKey },
        stage2: { revision, planKey, drawingIndexKey, count: persistedIndex?.count ?? 0 },
        stage3: {
          quoteComplete: Boolean(costResult.quote_complete),
          currency: costResult.currency,
          summary: costResult.summary,
          artifacts: stage3Keys
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existing = await project(this.env, event.payload.projectId).catch(() => null);
      await patchStatus(this.env, event.payload.projectId, "failed", existing?.current_stage ?? 0, message);
      throw error;
    }
  }
}
