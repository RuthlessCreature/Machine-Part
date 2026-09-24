import { Container } from "@cloudflare/containers";
import { CadPipelineWorkflow } from "./pipeline";
import { tokenPlanRemains } from "./minimax";
import type { Env, ProjectRow } from "./types";

export { CadPipelineWorkflow };

export class CadContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function idFrom(pathname: string, suffix = ""): string | null {
  const re = new RegExp(`^/api/projects/([^/]+)${suffix}$`);
  return pathname.match(re)?.[1] ?? null;
}

async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(id).first<ProjectRow>();
}

async function artifactResponse(env: Env, key: string | null): Promise<Response> {
  if (!key) return json({ error: "artifact not ready" }, 404);
  const obj = await env.BUCKET.get(key);
  if (!obj?.body) return json({ error: "artifact not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=60");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/health") {
      return json({ ok: true, service: "machine-part", version: "0.3.0" });
    }

    if (request.method === "GET" && pathname === "/api/minimax/quota") {
      try { return json(await tokenPlanRemains(env)); }
      catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
    }

    if (request.method === "POST" && pathname === "/api/projects") {
      const body = await request.json<any>().catch(() => ({}));
      const id = crypto.randomUUID();
      const name = String(body?.name || `Project ${id.slice(0, 8)}`);
      await env.DB.prepare(
        "INSERT INTO projects(id,name,status,current_stage,created_at,updated_at) VALUES(?,?,'created',0,datetime('now'),datetime('now'))"
      ).bind(id, name).run();
      return json({ id, name, status: "created" }, 201);
    }

    let id = idFrom(pathname);
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? json(p) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/source");
    if (id && request.method === "PUT") {
      const filename = url.searchParams.get("filename") || request.headers.get("x-filename") || "source.step";
      if (!request.body) return json({ error: "empty request body" }, 400);
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      const key = `projects/${id}/source/${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" } });
      await env.DB.prepare(
        "UPDATE projects SET status='uploaded', source_key=?, source_name=?, updated_at=datetime('now') WHERE id=?"
      ).bind(key, filename, id).run();
      return json({ ok: true, key, filename });
    }

    id = idFrom(pathname, "/run");
    if (id && request.method === "POST") {
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      const body = await request.json<any>().catch(() => ({}));
      const targetStage = Math.max(1, Math.min(3, Number(body.targetStage || 1))) as 1 | 2 | 3;
      const instance = await env.CAD_PIPELINE.create({
        id: `${id}-${Date.now()}`,
        params: {
          projectId: id,
          targetStage,
          selectedPartIds: Array.isArray(body.selectedPartIds) ? body.selectedPartIds : undefined,
          instruction: typeof body.instruction === "string" ? body.instruction : undefined,
          assemblyCandidate: typeof body.assemblyCandidate === "string" ? body.assemblyCandidate : undefined
        }
      });
      return json({ workflowId: instance.id, targetStage }, 202);
    }

    id = idFrom(pathname, "/assembly-candidates");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      return artifactResponse(env, `projects/${id}/assembly-candidates.json`);
    }

    id = idFrom(pathname, "/select-assembly");
    if (id && request.method === "POST") {
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      const body = await request.json<any>().catch(() => ({}));
      const candidate = typeof body.candidate === "string" ? body.candidate : "";
      if (!candidate) return json({ error: "candidate is required" }, 400);

      const candidatesObject = await env.BUCKET.get(`projects/${id}/assembly-candidates.json`);
      if (!candidatesObject) return json({ error: "assembly candidates not found" }, 409);
      const candidatesPayload: any = JSON.parse(await candidatesObject.text());
      const candidates = Array.isArray(candidatesPayload?.candidates) ? candidatesPayload.candidates : [];
      const selected = candidates.find((item: any) => item?.path === candidate);
      if (!selected) return json({ error: "candidate is not in the discovered assembly list" }, 400);
      if (selected.requires_converter) {
        await env.DB.prepare(
          "UPDATE projects SET status='converter_required', last_error=?, updated_at=datetime('now') WHERE id=?"
        ).bind("Native SolidWorks requires a configured converter adapter before Stage 1 can continue.", id).run();
        return json({
          status: "converter_required",
          candidate: selected,
          error: "Native SolidWorks converter adapter is not configured"
        }, 409);
      }

      const targetStage = Math.max(1, Math.min(3, Number(body.targetStage || 1))) as 1 | 2 | 3;
      const instance = await env.CAD_PIPELINE.create({
        id: `${id}-assembly-${Date.now()}`,
        params: {
          projectId: id,
          targetStage,
          assemblyCandidate: candidate,
          instruction: typeof body.instruction === "string" ? body.instruction : undefined
        }
      });
      return json({ workflowId: instance.id, targetStage, candidate }, 202);
    }

    id = idFrom(pathname, "/manifest");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.manifest_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/assembly.glb");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.glb_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/drawings");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.drawing_index_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/costing");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.costing_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/bom.xlsx");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.bom_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/quotation.pdf");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      return p ? artifactResponse(env, p.quotation_key) : json({ error: "project not found" }, 404);
    }

    id = idFrom(pathname, "/bom.csv");
    if (id && request.method === "GET") {
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      return artifactResponse(env, `projects/${id}/stage3/r${p.current_revision}/bom.csv`);
    }

    const drawingMatch = pathname.match(/^\/api\/projects\/([^/]+)\/drawings\/([^/]+)\/(json|svg|pdf|dxf)$/);
    if (drawingMatch && request.method === "GET") {
      const [, projectId, partId, format] = drawingMatch;
      const p = await getProject(env, projectId);
      if (!p) return json({ error: "project not found" }, 404);
      const requested = Number(url.searchParams.get("revision"));
      const revision = Number.isFinite(requested) && requested >= 0 ? requested : p.current_revision;
      const key = `projects/${projectId}/stage2/${partId}/r${revision}/drawing.${format}`;
      return artifactResponse(env, key);
    }

    id = idFrom(pathname, "/revise");
    if (id && request.method === "POST") {
      const p = await getProject(env, id);
      if (!p) return json({ error: "project not found" }, 404);
      if (p.current_stage < 2) return json({ error: "Stage 2 draft is not ready" }, 409);
      const body = await request.json<any>().catch(() => ({}));
      const partId = typeof body.partId === "string" ? body.partId : "";
      const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
      if (!partId || !feedback) return json({ error: "partId and feedback are required" }, 400);
      const revision = p.current_revision + 1;
      const reviewKey = `projects/${id}/stage2/reviews/r${revision}.json`;
      await env.BUCKET.put(reviewKey, JSON.stringify({
        projectId: id,
        partId,
        revision,
        feedback,
        createdAt: new Date().toISOString()
      }), { httpMetadata: { contentType: "application/json" } });
      const instance = await env.CAD_PIPELINE.create({
        id: `${id}-revision-${revision}-${Date.now()}`,
        params: {
          projectId: id,
          targetStage: 2,
          selectedPartIds: [partId],
          instruction: `Reviewer feedback for drawing revision ${revision}: ${feedback}`,
          revision
        }
      });
      return json({ workflowId: instance.id, revision, reviewKey }, 202);
    }

    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};
