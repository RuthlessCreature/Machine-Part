export interface Project {
  id: string;
  name: string;
  status: string;
  current_stage: number;
  current_revision: number;
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

export interface DrawingRecord {
  part_id: string;
  part_name: string;
  revision: number;
  features: Array<Record<string, unknown>>;
  artifacts: Record<"json" | "svg" | "pdf" | "dxf", string>;
}

export interface DrawingIndex {
  project_id: string;
  revision: number;
  count: number;
  drawings: DrawingRecord[];
  release_status: string;
}
