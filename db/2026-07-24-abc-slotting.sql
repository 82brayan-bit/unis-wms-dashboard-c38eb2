
-- ════════════════════════════════════════════════════════════════
-- ABC Inventory Slotting and Trend Analysis Module
-- Additive production schema. All operational data is scoped by facility_code + customer_id.
-- ════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS abc_sku_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  item_description TEXT,
  item_category TEXT,
  unit_of_measure TEXT,
  case_quantity NUMERIC DEFAULT 0,
  inner_pack_quantity NUMERIC DEFAULT 0,
  pallet_quantity NUMERIC DEFAULT 0,
  cases_per_pallet NUMERIC DEFAULT 0,
  units_per_pallet NUMERIC DEFAULT 0,
  case_length NUMERIC DEFAULT 0,
  case_width NUMERIC DEFAULT 0,
  case_height NUMERIC DEFAULT 0,
  case_cube NUMERIC DEFAULT 0,
  unit_weight NUMERIC DEFAULT 0,
  case_weight NUMERIC DEFAULT 0,
  pallet_weight NUMERIC DEFAULT 0,
  stackable BOOLEAN DEFAULT false,
  maximum_stack_height NUMERIC DEFAULT 0,
  hazmat_status TEXT,
  temperature_requirement TEXT,
  lot_controlled BOOLEAN DEFAULT false,
  serial_controlled BOOLEAN DEFAULT false,
  expiration_controlled BOOLEAN DEFAULT false,
  fifo_fefo_requirement TEXT,
  current_storage_type TEXT,
  current_zone TEXT,
  current_location TEXT,
  current_rack_level TEXT,
  active_status TEXT DEFAULT 'ACTIVE',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(facility_code, customer_id, sku)
);

ALTER TABLE abc_sku_master ADD COLUMN IF NOT EXISTS available_quantity NUMERIC DEFAULT 0;
ALTER TABLE abc_sku_master ADD COLUMN IF NOT EXISTS available_location TEXT;
ALTER TABLE abc_sku_master ADD COLUMN IF NOT EXISTS availability_checked_at TIMESTAMPTZ;
ALTER TABLE abc_sku_master ADD COLUMN IF NOT EXISTS inactive_reason TEXT;

CREATE TABLE IF NOT EXISTS abc_location_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  location_id TEXT NOT NULL,
  zone TEXT,
  tag_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tag_name TEXT,
  tag_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_type TEXT,
  rack_or_bulk TEXT,
  aisle TEXT,
  bay TEXT,
  level TEXT,
  position TEXT,
  length_capacity NUMERIC DEFAULT 0,
  width_capacity NUMERIC DEFAULT 0,
  height_capacity NUMERIC DEFAULT 0,
  cube_capacity NUMERIC DEFAULT 0,
  weight_capacity NUMERIC DEFAULT 0,
  pallet_capacity NUMERIC DEFAULT 0,
  pickable_status BOOLEAN DEFAULT false,
  reserve_status BOOLEAN DEFAULT false,
  temperature_zone TEXT,
  hazmat_compatible BOOLEAN DEFAULT false,
  distance_from_shipping NUMERIC DEFAULT 0,
  distance_from_receiving NUMERIC DEFAULT 0,
  active_status TEXT DEFAULT 'ACTIVE',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(facility_code, location_id)
);

CREATE TABLE IF NOT EXISTS abc_inbound_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_date_time TIMESTAMPTZ NOT NULL,
  sku TEXT NOT NULL,
  units_received NUMERIC DEFAULT 0,
  cases_received NUMERIC DEFAULT 0,
  pallets_received NUMERIC DEFAULT 0,
  supplier TEXT,
  purchase_order TEXT,
  receiving_location TEXT,
  putaway_location TEXT,
  putaway_date_time TIMESTAMPTZ,
  receiving_to_putaway_minutes NUMERIC DEFAULT 0,
  operator_name TEXT,
  damage_quantity NUMERIC DEFAULT 0,
  hold_quantity NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_outbound_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  shipment_id TEXT,
  order_date TIMESTAMPTZ NOT NULL,
  ship_date TIMESTAMPTZ,
  sku TEXT NOT NULL,
  ordered_units NUMERIC DEFAULT 0,
  picked_units NUMERIC DEFAULT 0,
  picked_cases NUMERIC DEFAULT 0,
  picked_pallets NUMERIC DEFAULT 0,
  pick_type TEXT,
  each_pick NUMERIC DEFAULT 0,
  case_pick NUMERIC DEFAULT 0,
  full_pallet_pick NUMERIC DEFAULT 0,
  pick_location TEXT,
  pick_zone TEXT,
  picker TEXT,
  number_of_order_lines NUMERIC DEFAULT 1,
  number_of_location_visits NUMERIC DEFAULT 1,
  short_quantity NUMERIC DEFAULT 0,
  cancelled_quantity NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_inventory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  sku TEXT NOT NULL,
  on_hand_units NUMERIC DEFAULT 0,
  available_units NUMERIC DEFAULT 0,
  allocated_units NUMERIC DEFAULT 0,
  hold_units NUMERIC DEFAULT 0,
  damaged_units NUMERIC DEFAULT 0,
  on_hand_cases NUMERIC DEFAULT 0,
  on_hand_pallets NUMERIC DEFAULT 0,
  number_of_occupied_locations NUMERIC DEFAULT 0,
  total_occupied_cube NUMERIC DEFAULT 0,
  days_of_supply NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(facility_code, customer_id, snapshot_date, sku)
);

CREATE TABLE IF NOT EXISTS abc_analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  calculation_method TEXT NOT NULL,
  analysis_type TEXT DEFAULT 'combined',
  thresholds JSONB DEFAULT '{}'::jsonb,
  scoring_weights JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'PENDING',
  error_message TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

ALTER TABLE abc_analysis_runs ADD COLUMN IF NOT EXISTS sync_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS abc_calculation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES abc_analysis_runs(id) ON DELETE CASCADE,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  total_outbound_units NUMERIC DEFAULT 0,
  total_outbound_cases NUMERIC DEFAULT 0,
  total_outbound_pallets NUMERIC DEFAULT 0,
  pick_lines NUMERIC DEFAULT 0,
  order_count NUMERIC DEFAULT 0,
  average_daily_movement NUMERIC DEFAULT 0,
  average_weekly_movement NUMERIC DEFAULT 0,
  average_monthly_movement NUMERIC DEFAULT 0,
  annualized_movement NUMERIC DEFAULT 0,
  activity_percentage NUMERIC DEFAULT 0,
  cumulative_percentage NUMERIC DEFAULT 0,
  abc_class TEXT,
  previous_abc_class TEXT,
  abc_class_change TEXT,
  calculation_method TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

ALTER TABLE abc_calculation_results ADD COLUMN IF NOT EXISTS currently_in_inventory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE abc_calculation_results ADD COLUMN IF NOT EXISTS available_quantity NUMERIC DEFAULT 0;
ALTER TABLE abc_calculation_results ADD COLUMN IF NOT EXISTS available_location TEXT;
ALTER TABLE abc_calculation_results ADD COLUMN IF NOT EXISTS inactive_reason TEXT;

CREATE TABLE IF NOT EXISTS abc_trend_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES abc_analysis_runs(id) ON DELETE CASCADE,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  trend_status TEXT,
  inbound_growth_percentage NUMERIC DEFAULT 0,
  outbound_growth_percentage NUMERIC DEFAULT 0,
  inbound_units NUMERIC DEFAULT 0,
  outbound_units NUMERIC DEFAULT 0,
  average_daily_inbound NUMERIC DEFAULT 0,
  average_daily_outbound NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_slotting_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES abc_analysis_runs(id) ON DELETE CASCADE,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  slotting_score NUMERIC DEFAULT 0,
  cube_velocity_score NUMERIC DEFAULT 0,
  outbound_velocity_score NUMERIC DEFAULT 0,
  pick_frequency_score NUMERIC DEFAULT 0,
  replenishment_score NUMERIC DEFAULT 0,
  inventory_score NUMERIC DEFAULT 0,
  inbound_score NUMERIC DEFAULT 0,
  trend_score NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_slotting_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES abc_analysis_runs(id) ON DELETE SET NULL,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  current_abc_class TEXT,
  previous_abc_class TEXT,
  current_trend TEXT,
  current_location TEXT,
  current_storage_type TEXT,
  recommended_storage_type TEXT,
  recommended_zone TEXT,
  recommended_level TEXT,
  recommended_pick_face_quantity NUMERIC DEFAULT 0,
  reason TEXT,
  supporting_calculation JSONB DEFAULT '{}'::jsonb,
  priority TEXT DEFAULT 'Medium',
  estimated_operational_benefit TEXT,
  recommendation_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status TEXT DEFAULT 'OPEN',
  assigned_user TEXT,
  approval_status TEXT DEFAULT 'PENDING',
  completion_status TEXT DEFAULT 'NOT_STARTED',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_slotting_configuration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_abc_config_scope_active_unique ON abc_slotting_configuration(facility_code, customer_id) WHERE active=true;

CREATE TABLE IF NOT EXISTS abc_recommendation_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES abc_slotting_recommendations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  action_by TEXT,
  comment TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_reslotting_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID REFERENCES abc_slotting_recommendations(id) ON DELETE SET NULL,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  task_type TEXT DEFAULT 'Re-Slot Inventory',
  source_location TEXT,
  destination_location TEXT,
  quantity_to_move NUMERIC DEFAULT 0,
  unit_of_measure TEXT,
  reason TEXT,
  priority TEXT DEFAULT 'Medium',
  assigned_user TEXT,
  due_date TIMESTAMPTZ,
  required_equipment TEXT,
  safety_instructions TEXT,
  status TEXT DEFAULT 'OPEN',
  completion_date TIMESTAMPTZ,
  completed_by TEXT,
  verification_status TEXT DEFAULT 'PENDING',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_reslotting_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES abc_reslotting_tasks(id) ON DELETE SET NULL,
  recommendation_id UUID REFERENCES abc_slotting_recommendations(id) ON DELETE SET NULL,
  facility_code TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  location_before TEXT,
  location_after TEXT,
  quantity_moved NUMERIC DEFAULT 0,
  completed_by TEXT,
  completed_at TIMESTAMPTZ,
  override_reason TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_user_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  facility_code TEXT,
  customer_id TEXT,
  sku TEXT,
  comment TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS abc_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_code TEXT,
  customer_id TEXT,
  sku TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  previous_value JSONB,
  new_value JSONB,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_abc_sku_scope ON abc_sku_master(facility_code, customer_id, sku);

ALTER TABLE abc_location_master ADD COLUMN IF NOT EXISTS tag_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE abc_location_master ADD COLUMN IF NOT EXISTS tag_name TEXT;
ALTER TABLE abc_location_master ADD COLUMN IF NOT EXISTS tag_names JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_abc_location_tag_name ON abc_location_master(facility_code, tag_name);
CREATE INDEX IF NOT EXISTS idx_abc_location_facility ON abc_location_master(facility_code, location_id);
CREATE INDEX IF NOT EXISTS idx_abc_inbound_scope_date ON abc_inbound_transactions(facility_code, customer_id, sku, receipt_date_time);
CREATE INDEX IF NOT EXISTS idx_abc_outbound_scope_date ON abc_outbound_transactions(facility_code, customer_id, sku, order_date);
CREATE INDEX IF NOT EXISTS idx_abc_snapshot_scope_date ON abc_inventory_snapshots(facility_code, customer_id, sku, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_abc_runs_scope_date ON abc_analysis_runs(facility_code, customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_abc_results_scope_class ON abc_calculation_results(facility_code, customer_id, sku, abc_class);
CREATE INDEX IF NOT EXISTS idx_abc_trends_scope_status ON abc_trend_results(facility_code, customer_id, sku, trend_status);
CREATE INDEX IF NOT EXISTS idx_abc_scores_scope ON abc_slotting_scores(facility_code, customer_id, sku);
CREATE INDEX IF NOT EXISTS idx_abc_recs_scope_status ON abc_slotting_recommendations(facility_code, customer_id, sku, approval_status, completion_status);
CREATE INDEX IF NOT EXISTS idx_abc_tasks_scope_status ON abc_reslotting_tasks(facility_code, customer_id, sku, status);
CREATE INDEX IF NOT EXISTS idx_abc_audit_scope ON abc_audit_log(facility_code, customer_id, sku, created_at);
