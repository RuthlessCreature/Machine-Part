import type { CadContainer } from "./index";

export type ProjectStatus =
  | "created"
  | "uploaded"
  | "ingesting"
  | "assembly_selection_required"
  | "converter_required"
  | "stage1_ready"
  | "stage2_generating"
  | "stage2_draft_ready"
  | "stage3_generating"
  | "stage3_ready"
  | "failed";

export interface PipelineParams {
  projectId: string;
  targetStage: 1 | 2 | 3;
  selectedPartIds?: string[];
  instruction?: string;
  revision?: number;
  assemblyCandidate?: string;
}

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  CAD_PIPELINE: Workflow<PipelineParams>;
  CAD_CONTAINER: DurableObjectNamespace<CadContainer>;
  ASSETS: Fetcher;
  MINIMAX_API_KEY: string;
  MINIMAX_CHAT_URL: string;
  MINIMAX_CHAT_PATH: string;
  MINIMAX_MODEL: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  current_stage: number;
  current_revision: number;
  source_key: string | null;
  source_name: string | null;
  manifest_key: string | null;
  glb_key: string | null;
  drawing_plan_key: string | null;
  drawing_index_key: string | null;
  costing_key: string | null;
  bom_key: string | null;
  quotation_key: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
