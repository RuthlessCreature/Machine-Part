import type { DrawingIndex, Manifest, Project } from "../types";

async function expect<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export async function createProject(name: string): Promise<Project> {
  return expect(await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  }));
}

export async function uploadSource(projectId: string, file: File): Promise<void> {
  await expect(await fetch(`/api/projects/${projectId}/source?filename=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file
  }));
}

export async function runPipeline(projectId: string, targetStage: 1 | 2 | 3, selectedPartIds: string[], instruction: string) {
  return expect(await fetch(`/api/projects/${projectId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetStage, selectedPartIds, instruction })
  }));
}

export async function reviseDrawing(projectId: string, partId: string, feedback: string) {
  return expect<{ workflowId: string; revision: number }>(await fetch(`/api/projects/${projectId}/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ partId, feedback })
  }));
}

export async function getProject(projectId: string): Promise<Project> {
  return expect(await fetch(`/api/projects/${projectId}`));
}

export async function getManifest(projectId: string): Promise<Manifest> {
  return expect(await fetch(`/api/projects/${projectId}/manifest`));
}

export async function getDrawings(projectId: string): Promise<DrawingIndex> {
  return expect(await fetch(`/api/projects/${projectId}/drawings`));
}

export function glbUrl(projectId: string) {
  return `/api/projects/${projectId}/assembly.glb`;
}

export function drawingUrl(projectId: string, partId: string, format: "json" | "svg" | "pdf" | "dxf", revision?: number) {
  const query = revision === undefined ? "" : `?revision=${revision}`;
  return `/api/projects/${projectId}/drawings/${partId}/${format}${query}`;
}
