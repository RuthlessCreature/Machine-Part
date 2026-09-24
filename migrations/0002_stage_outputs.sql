ALTER TABLE projects ADD COLUMN current_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN drawing_plan_key TEXT;
ALTER TABLE projects ADD COLUMN drawing_index_key TEXT;
ALTER TABLE projects ADD COLUMN costing_key TEXT;
ALTER TABLE projects ADD COLUMN bom_key TEXT;
ALTER TABLE projects ADD COLUMN quotation_key TEXT;
