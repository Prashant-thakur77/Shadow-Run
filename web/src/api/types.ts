// Shapes from docs/API.md and web/fixtures. Everything beyond the id is optional on purpose:
// a run blocked by the gate has no report, an in-progress run has no attempts.

export type Dict = Record<string, unknown>;

export interface Me {
  username: string;
  name?: string;
  role?: string;
  token?: string;
}

export interface Can {
  approve?: boolean;
  approve_blocked_reason?: string | null;
  apply?: boolean;
  rehearse_again?: boolean;
}

export interface Challenge {
  run_id?: string;
  plan_hash: string;
  guardrails_hash: string;
  report_hash: string;
  nonce: string;
  expires_at?: number;
}

export interface TimelineEvent {
  t?: number;
  type: string;
  actor?: string;
  detail?: Dict | null;
  seq?: number;
}

export interface PlanStep {
  type?: string;
  cmd?: string;
  why?: string;
  statements?: string[];
}

export interface GateFinding {
  step?: number;
  statement?: string;
  rule?: string;
  severity?: string;
  reason?: string;
}

export interface Gate {
  verdict?: string;
  flagged?: boolean;
  findings?: GateFinding[];
  steps?: { step: number; risk?: string }[];
  highest_risk?: string;
}

export interface GuardrailResult {
  id?: string;
  name?: string;
  passed?: boolean;
  violations?: Dict[];
  violation_count_capped?: number;
  error?: string | null;
  /** Host targets: what the shell check printed. */
  output?: string;
  ms?: number;
}

export interface Proof {
  holds_on_clean_clone?: boolean;
  catches_the_plan?: boolean;
  allows_normal_work?: boolean | null;
  normal_error?: string | null;
  proved?: boolean;
  clean_error?: string | null;
  plan_error?: string | null;
}

export interface Guardrail {
  id?: string;
  name?: string;
  sql?: string;
  /** Host targets: a shell check instead of SQL. */
  sh?: string;
  /** Where a guardrail came from, when it was learned rather than written by a person. */
  learned_from?: { kind?: string; run?: string; reason?: string; rejected_by?: string; gauntlet?: string; round?: number } | null;
  proof?: Proof | null;
  why?: string;
  accepted_by?: string;
  drafted_by?: string;
}

export interface Budget {
  max_rows_changed?: number;
  max_table_pct?: number;
  max_cascade_rows?: number;
  allow_drop?: boolean;
  allow_truncate?: boolean;
  allow_ddl?: boolean;
  [k: string]: unknown;
}

export interface Explanation {
  text?: string;
  numbers_verified?: boolean;
  unverified_numbers?: string[];
  note?: string;
}

export interface ReportTotals {
  rows_inserted?: number;
  rows_updated?: number;
  rows_deleted?: number;
  rows_changed?: number;
  rows_via_cascade?: number;
  tables_touched?: number;
  tables_dropped?: number;
  tables_truncated?: number;
  ddl_commands?: number;
  // Host targets
  files_created?: number;
  files_deleted?: number;
  files_changed?: number;
  bytes_freed?: number;
  services_stopped?: number;
  ports_closed?: number;
}

export interface ReportTable {
  table: string;
  rows_before?: number | null;
  rows_after?: number | null;
  inserted?: number;
  updated?: number;
  deleted?: number;
  direct?: number;
  cascade?: number;
  pct_of_table?: number | null;
  dropped?: boolean;
  truncated?: boolean;
  via?: string[];
}

export interface ReportSentence {
  step?: number;
  table?: string;
  op?: string;
  rows?: number;
  via?: string;
  path?: string | null;
  text?: string;
}

export interface CascadeNode {
  table: string;
  deleted?: number;
  updated?: number;
  direct?: number;
  cascade?: number;
}

export interface CascadeEdge {
  from: string;
  to: string;
  on_delete?: string;
  rows?: number;
}

export interface SampleRow {
  before?: Dict | null;
  after?: Dict | null;
}

export interface FileCounts {
  created?: number;
  deleted?: number;
  changed?: number;
}

export interface Metric {
  id?: string;
  name?: string;
  unit?: string;
  before?: number | null;
  after?: number | null;
  delta?: number | null;
  lost_entirely?: boolean;
}

export interface Report {
  metrics?: Metric[];
  capture_gaps?: { table?: string; op?: string; postgres_counted?: number; log_has?: number }[];
  unlogged_changes?: { table?: string; detail?: string }[];
  /** "host" for a Linux host. Absent for a database. */
  kind?: string;
  files?: { created?: string[]; deleted?: string[]; changed?: string[]; counts?: FileCounts; bytes_freed?: number };
  deleted_by_directory?: { path: string; files?: number }[];
  services_stopped?: string[];
  services_started?: string[];
  ports_closed?: (string | number)[];
  services_after?: { running?: string[]; listening_ports?: (string | number)[] };
  totals?: ReportTotals;
  tables?: ReportTable[];
  sentences?: ReportSentence[];
  cascade_graph?: { nodes?: CascadeNode[]; edges?: CascadeEdge[] };
  samples?: Record<string, Record<string, SampleRow[]>>;
  ddl?: { step?: number; tag?: string; object_type?: string; identity?: string }[];
  schema_diff?: { kind?: string; name?: string; change?: string }[];
  changed_columns?: Record<string, Record<string, number>> | null;
}

export interface StatementResult {
  sql?: string;
  tag?: string;
  rowcount?: number;
  ok?: boolean;
  ms?: number;
  error?: string;
}

export interface ProbeTarget {
  label?: string;
  host?: string;
  port?: number;
  result?: string;
  how?: string;
}

export interface Phases {
  clone_boot_ms?: number;
  first_exec_ms?: number;
  systemd_boot_ms?: number;
  load_state_ms?: number;
  probe_ms?: number;
  execute_ms?: number;
  secret_scan_ms?: number;
  destroy_ms?: number;
  total_ms?: number;
}

export interface Rehearsal {
  run_id?: string;
  snapshot_id?: string;
  sandbox?: string;
  limits?: { cpus?: number; memory_mib?: number; max_duration_s?: number; network?: string };
  host?: { kernel?: string; hostname?: string; kvm_device?: boolean; kvm_rw?: boolean };
  guest?: { kernel?: string; hostname?: string };
  image?: { reference?: string; digest?: string };
  probes?: { ok?: boolean; nics?: string[]; routes?: number; targets?: ProbeTarget[]; dns?: string };
  secret_scan?: { ok?: boolean; scanned?: number; hits?: unknown[] };
  teardown?: { sandbox_listed?: boolean; rootfs_exists?: boolean; leftover_processes?: number; other_run_sandboxes?: number; ok?: boolean };
  phases?: Phases;
  contained?: boolean;
  metrics?: { memory_bytes?: number; memory_limit_bytes?: number; net_rx_bytes?: number; net_tx_bytes?: number; uptime_ms?: number };
  sandbox_error?: string | null;
  boot_state?: string;
  result?: {
    ok?: boolean;
    error?: string | null;
    steps?: { step?: number; ok?: boolean; statements?: StatementResult[]; exit_code?: number | null; output?: string; ms?: number }[];
  } | null;
}

export interface Reproduced {
  ok?: boolean;
  differs?: string[];
  sandbox?: string;
  ms?: number;
  contained?: boolean;
}

export interface UndoInfo {
  possible?: boolean;
  verified?: boolean;
  detail?: string;
  why?: string;
  statements?: number;
  bytes?: number;
  rows_restored?: number;
  rows_reverted?: number;
  rows_removed?: number;
  too_large_to_store?: boolean;
}

export interface Attempt {
  reproduced?: Reproduced;
  undo?: UndoInfo | null;
  n: number;
  verdict?: string;
  error?: string | null;
  plan?: { steps?: PlanStep[]; summary?: string };
  plan_hash?: string;
  guardrails_hash?: string;
  report_hash?: string;
  gate?: Gate;
  guardrails?: GuardrailResult[];
  budget?: { within?: boolean; reasons?: string[]; limits?: Budget };
  explanation?: Explanation;
  report?: Report;
  rehearsal?: Rehearsal;
}

export interface Counts {
  ins?: number;
  upd?: number;
  del?: number;
}

export interface ApplyOutcome {
  outcome?: string;
  reason?: string;
  expected_counts?: Record<string, Counts>;
  actual_counts?: Record<string, Counts>;
  count_mismatches?: { table: string; rehearsal?: Counts; actual?: Counts }[];
  content_mismatches?: { table: string; rehearsal?: { rows?: number | null; hash?: string | null }; actual?: { rows?: number | null; hash?: string | null } }[];
  drifted_tables?: { table: string; at_rehearsal?: { rows?: number; hash?: string }; now?: { rows?: number; hash?: string } }[];
  drift_checked?: string[];
  schema_matches?: boolean;
  // Host targets
  expected_files?: FileCounts | null;
  files?: FileCounts | null;
  expected_services_stopped?: string[] | null;
  services_stopped?: string[] | null;
  fingerprint_at_rehearsal?: string | null;
  fingerprint_now?: string | null;
  restored?: boolean;
  guardrails?: GuardrailResult[];
  ms?: number;
}

export interface Approval {
  approver_id?: string;
  kind?: string;
  plan_hash?: string;
  guardrails_hash?: string;
  report_hash?: string;
  nonce?: string;
  signature?: string;
  granted_at?: number;
}

export interface StoredObject {
  path?: string;
  store?: string;
  bucket?: string;
  key?: string;
  bytes?: number;
  ms?: number;
  bundle_sha256?: string;
  error?: string;
}

export interface DataFlag {
  table?: string;
  column?: string;
  preview?: string;
  model?: string;
  verdict?: string;
  raw?: string;
}

export interface Usage {
  phase?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
  seconds?: number;
}

export interface IncidentRef {
  id?: string;
  when?: string;
  who?: string;
  source?: string;
  happened?: string;
  adapted?: string;
}

export interface Run {
  prod_before_apply?: string | null;
  rehearse_only?: boolean;
  undo_of?: string;
  incident?: IncidentRef | null;
  id: string;
  status: string;
  requester?: string;
  source?: string;
  task?: string | null;
  target_id?: string;
  created_at?: number;
  updated_at?: number;
  error?: string | null;
  blocked_reason?: string | null;
  can?: Can;
  challenge?: Challenge | null;
  timeline?: TimelineEvent[];
  attempts?: Attempt[];
  final_attempt?: number | null;
  final?: Attempt | null;
  plan_hash?: string | null;
  guardrails_hash?: string | null;
  report_hash?: string | null;
  guardrails?: Guardrail[];
  data_flags?: DataFlag[];
  snapshot?: { snapshot_id?: string; lsn?: string; digest?: string; cached?: boolean };
  approval?: Approval | null;
  rejection?: { by?: string; reason?: string; at?: number } | null;
  apply?: ApplyOutcome | null;
  backup?: StoredObject | null;
  evidence?: StoredObject | null;
  evidence_url?: string | null;
  prod_after?: string | null;
  prod_check?: { before?: string; after?: string; unchanged?: boolean | null; measured_from?: string; error?: string } | null;
  usage?: Usage[];
  cost_usd?: number | null;
  rerun?: string | null;
  rehearses_again?: string;
  chain_head?: string;
}

export interface RunSummary {
  id: string;
  plan_preview?: string | null;
  files_changed?: number | null;
  services_stopped?: number | null;
  created_at?: number;
  status: string;
  requester?: string;
  task?: string | null;
  source?: string;
  target_id?: string;
  plan_hash?: string | null;
  attempts?: number;
  rows_changed?: number | null;
  rows_via_cascade?: number | null;
  guardrails_failed?: number;
  cost_usd?: number | null;
  rehearsal_ms?: number | null;
}

export interface ProdChecksum {
  digest?: string;
  lsn?: string;
  rows?: Record<string, number>;
  /** Host targets */
  files?: number;
  at?: number;
}

export interface Firewall {
  available?: boolean;
  rules?: number;
  rejected_packets?: number;
}

export interface Health {
  ok?: boolean;
  s3?: boolean;
  inference_base_is_vultr?: boolean;
  planner_model?: string;
  runner?: {
    host?: { kernel?: string; hostname?: string; kvm_device?: boolean; kvm_rw?: boolean };
    msb_doctor_ok?: boolean;
    image_digest?: string;
    firewall?: Firewall;
  };
  runner_error?: string;
}

export interface AttackDef {
  id: string;
  title?: string;
  expected?: string;
}

export interface AttackCheck {
  check?: string;
  ok?: boolean;
  detail?: unknown;
}

export interface AttackResult {
  time_cap_s?: number;
  attack: string;
  title?: string;
  expected?: string;
  contained?: boolean;
  checks?: AttackCheck[];
  inside_output?: string;
  wall_s?: number;
  ended?: string | null;
  exit_code?: number | null;
  sandbox?: string;
  sandbox_error?: string | null;
  host_before?: { load_1m?: number; mem_available_mib?: number; cpus?: number };
  host_after?: { load_1m?: number; mem_available_mib?: number; cpus?: number };
  firewall?: { rejected_before?: number; rejected_after?: number; delta?: number; rules?: number };
}

export interface WallTwo {
  what?: string;
  output?: string;
  firewall_before?: Firewall;
  firewall_after?: Firewall;
  rejected_delta?: number;
  reached_outside?: boolean;
  contained?: boolean;
  rootfs_gone?: boolean;
  error?: string;
}

export interface RedTeamRun {
  id: string;
  status?: string;
  requester?: string;
  created_at?: number;
  expected?: number;
  attacks?: AttackResult[];
  prod_before?: string;
  prod_during?: string;
  prod_after?: string;
  prod_unchanged?: boolean;
  contained?: number;
  total?: number;
  wall_two?: WallTwo;
  error?: string;
}

export interface Target {
  id: string;
  name?: string;
  kind?: string;
  guardrails?: Guardrail[];
  guardrails_hash?: string;
  budget?: Budget;
  auto_apply_within_budget?: boolean;
}

export interface InspectColumn {
  name?: string;
  type?: string;
  nullable?: string;
  default?: string | null;
}

export interface Inspect {
  served_from?: string;
  snapshot_id?: string;
  tables?: { name: string; columns?: InspectColumn[]; row_count?: number; sample_rows?: Dict[] }[];
  foreign_keys?: { child?: string; parent?: string; constraint?: string; on_delete?: string }[];
}

export interface GuardrailDraft {
  id?: string;
  name?: string;
  sql?: string;
  why?: string;
  holds_today?: boolean;
  error?: string | null;
}

export interface AuditEvent {
  seq: number;
  run_id?: string | null;
  ts?: number;
  actor?: string;
  type?: string;
  detail?: unknown;
  prev_sha256?: string;
  sha256?: string;
}

export interface Audit {
  events?: AuditEvent[];
  chain?: { ok?: boolean; events?: number; head?: string; broken_at?: number };
}

export interface Candidate {
  id: string;
  name?: string;
  sql?: string;
  why?: string;
  origin?: Guardrail['learned_from'];
  proof?: Proof;
  cost_usd?: number;
}

export interface GauntletRound {
  n: number;
  outcome?: string;
  idea?: string;
  plan?: string[];
  detail?: string;
  caught_by?: string[];
  rows?: { DELETE?: number; UPDATE?: number; INSERT?: number };
  metrics_moved?: { name?: string; unit?: string; before?: number | null; after?: number | null }[];
  harm_check?: string;
  would_auto_apply?: boolean;
  held_because?: string[];
  candidate?: Candidate;
}

export interface GauntletPublished {
  measured?: boolean;
  at?: string;
  model?: string;
  baseline_summary?: Gauntlet['summary'];
  first_summary?: Gauntlet['summary'];
  summary?: Gauntlet['summary'];
  replay?: GauntletReplay;
  adopted?: string[];
  guardrails_before?: number;
  guardrails_after?: number;
  cost_usd?: number;
  rerun?: string;
}

export interface GauntletReplay {
  at?: number;
  guardrails?: number;
  total?: number;
  caught?: number;
  did_not_run?: number;
  attacks?: { n: number; idea?: string; ran?: boolean; caught?: boolean; caught_by?: string[] }[];
}

export interface Gauntlet {
  id: string;
  target_id?: string;
  status?: string;
  expected?: number;
  model?: string;
  rounds?: GauntletRound[];
  summary?: { rounds?: number; real_attacks?: number; caught?: number; got_through?: number; held_for_a_person?: number; would_auto_apply?: number; no_effect?: number; invalid?: number; reach_alone?: string[] };
  policy?: string;
  replay?: GauntletReplay;
  cost_usd?: number;
  created_at?: number;
  requester?: string;
  error?: string;
}

export interface PublicInfo {
  open_demo?: boolean;
  headline?: {
    risky_tasks?: number;
    direct?: number;
    static_gate?: number;
    shadow_run?: number;
    rubber_stamp?: number;
    runs_per_task?: number;
    measured_at?: string | number;
  } | null;
  video_url?: string | null;
  repo?: string | null;
}

export interface Incident {
  id: string;
  when?: string;
  who?: string;
  source?: string;
  happened?: string;
  target?: string;
  command?: string;
  adapted?: string;
}

export interface Receipt {
  group?: string;
  claim?: string;
  value?: unknown;
  values?: unknown;
  must?: unknown;
  detail?: unknown;
  at?: string | number;
  source?: string;
  rerun?: string;
  commit?: string;
}
