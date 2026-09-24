export interface Project {
  id: string;
  name: string;
  status: string;
  current_stage: number;
  last_error?: string | null;
}

export interface CadNode {
  id: string;
  name: string;
  parent_id: string | null;
  kind: "assembly" | "part";
  children: string[];
  bbox_mm?: { min: number[]; max: number[]; size: number[] };
  volume_mm3?: number;
  surface_area_mm2?: number;
}

export interface Manifest {
  project_id: string;
  counts: { nodes: number; assemblies: number; parts: number };
  nodes: CadNode[];
}
