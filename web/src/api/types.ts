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

export interface SecondOpinion {
  model?: string;
  verdict?: 'does_it' | 'partly' | 'does_not';
  left_out?: string;
  added?: string;
  numbers_verified?: boolean;
  unverified_numbers?: string[];
  error?: string;
}

/** A plan that broke a rule and then passed: did it meet the rule or get around it? From control/evasion.py. */
export interface Evasion {
  evaded?: boolean;
  rewrote?: { rule: string; columns: string[] }[];
  read?: { model?: string; verdict?: 'respects_it' | 'gets_around_it' | 'gave_up' | 'no_answer'; reason?: string; error?: string };
}

export interface Attempt {
  second_opinion?: SecondOpinion | null;
  evasion?: Evasion | null;
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

/** One task, both ways at once. Each lane is an ordinary run, so the page polls those. */
export interface Race {
  id: string;
  created_at?: number;
  requester?: string;
  task: string;
  target_id?: string;
  alone: string;
  through: string;
}

/** The newest race that finished, offered when a visitor's own race is slow, with the median time of recent races. */
export interface RecordedRace extends Race {
  seconds?: number | null;
  left_lane_broke_a_rule?: boolean;
  typical_seconds?: number | null;
  races_timed?: number;
}

/** What "change prod behind its back" would write for this run, from what its rehearsal touched. */
export interface DriftPlan {
  host?: boolean;
  /** The table the write goes to. Null when no touched table can be changed, and `why` says so. */
  table?: string | null;
  touched?: string[];
  /** False when the plan drops or empties that table, so with the drift check off nothing could notice the write. */
  caught_with_check_off?: boolean;
  why?: string;
}

export interface Run {
  /** Set on a race's two lanes. They only rehearse, and the server refuses to approve or apply them. */
  race?: { id: string; lane: 'alone' | 'through' } | null;
  /** This plan came from a race's right lane, and the server checked the steps are that plan. */
  from_race?: { id: string; run: string; plan_hash: string } | null;
  /** The approval window has closed, so nothing can be approved until it is rehearsed again. */
  expired?: boolean;
  approval_expires_at?: number;
  /** The agent declined, which isn't a plan that something stopped. */
  refused?: { reason?: string | null } | null;
  drift?: DriftPlan | null;
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
  snapshot?: { snapshot_id?: string; lsn?: string; digest?: string; cached?: boolean; tables?: Record<string, { rows?: number; hash?: string }>; files?: number };
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
  expired?: boolean;
  race_lane?: 'alone' | 'through' | null;
  refused?: boolean;
  /** Why this run is on the short list new visitors see. */
  example?: string;
}

export interface RunFeed {
  mine: RunSummary[];
  examples: RunSummary[];
}

export interface ProdChecksum {
  digest?: string;
  lsn?: string;
  rows?: Record<string, number>;
  /** The hash at the last reseed. Null until one has happened, so nothing can be said before then. */
  seed_digest?: string | null;
  changed_from_seed?: boolean;
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
  golden_unchanged?: boolean;
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
    /** Risky tasks done with no harm, by mode. */
    done_direct?: number;
    done_static_gate?: number;
    done_unread?: number;
    /** Risky tasks held for a person, with no person there. */
    held?: number;
    runs_per_task?: number;
    measured_at?: string | number;
    /** The tasks from outside this project, where the gap is smaller. */
    external?: { risky_tasks?: number; done_direct?: number; done_unread?: number } | null;
    /** bench/stats.py's paired test over tasks, approved unread against the agent alone. */
    task_level?: TaskLevel | null;
  } | null;
  hero?: PublicHero | null;
  /** A real run a person approved and that applied, because the hero's replay is blocked before that part. */
  applied_example?: AppliedExample | null;
  video_url?: string | null;
  repo?: string | null;
}

export interface AppliedExample {
  run_id: string;
  measured_at?: number | null;
  plan_hash?: string | null;
  /** On the rehearsal. */
  rows_changed?: number | null;
  prod_before?: string | null;
  prod_after?: string | null;
  /** On prod, by table. */
  actual_counts?: Record<string, { ins?: number; upd?: number; del?: number }> | null;
  /** The plan's undo was proved on a clone before anyone approved it. */
  undo_verified?: boolean | null;
  /** A second clone reproduced the result. */
  reproduced?: boolean | null;
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

/** Who pays, from docs/market.json. Sources travel with the figures. */
export interface Market {
  as_of?: string;
  agents_market?: { usd_b_2025?: number; usd_b_2033?: number; source?: string; url?: string };
  guardian_share?: { low_pct?: number; high_pct?: number; by_year?: number; source?: string; url?: string };
  developers_using_agents?: { weekly_pct?: number; daily_pct?: number; respondents?: string; source?: string; url?: string };
  agent_incidents?: { unexpected_or_unauthorized_pct?: number; of_those_modified_or_deleted_data_pct_over?: number; can_stop_automatically_pct?: number; respondents?: string; source?: string; url?: string };
  postgres_companies?: { count?: number; source?: string; url?: string; caveat?: string };
  price?: { usd_per_database_month?: number; label?: string };
  derived?: { tam_how?: string; sam_usd_b_per_year?: number; sam_how?: string; first_target_pct?: number; first_target_usd_m_per_year?: number };
  revenue?: string[];
  funnel?: string[];
  next?: string[];
  competition?: { who?: string; strength?: string; gap?: string; urls?: string[] }[];
  us?: { strength?: string; weakness?: string; usp?: string };
}

export interface Receipt {
  group?: string;
  claim?: string;
  value?: unknown;
  values?: unknown;
  must?: unknown;
  /** Negative controls: what the server actually said, such as "403 maker-checker: ...". */
  got?: string;
  /** Negative controls: "attack" or "honest path". */
  kind?: string;
  /** Soak: how many rehearsals the yes covers. */
  count?: number;
  detail?: unknown;
  at?: string | number;
  source?: string;
  rerun?: string;
  commit?: string;
}

/** One real rehearsal of a real incident, whitelisted field by field in control/hero.py so it can reach a page with no login. */
export interface PublicHero {
  run_id: string;
  measured_at?: number | null;
  incident: { who?: string | null; when?: string | null; source?: string | null };
  command: string[];
  plan_hash?: string | null;
  /** Offsets in seconds from the first event of the run. */
  timeline: { type: string; t: number }[];
  phases: {
    clone_boot_ms?: number | null;
    first_exec_ms?: number | null;
    probe_ms?: number | null;
    execute_ms?: number | null;
    secret_scan_ms?: number | null;
    destroy_ms?: number | null;
    total_ms?: number | null;
    /** Host targets only: a Linux host boots systemd and loads its state before the plan runs. */
    systemd_boot_ms?: number | null;
    load_state_ms?: number | null;
  };
  tables: {
    table: string;
    rows_before?: number | null;
    rows_after?: number | null;
    deleted?: number | null;
    updated?: number | null;
    inserted?: number | null;
    cascade?: number | null;
    pct_of_table?: number | null;
  }[];
  snapshot_rows: Record<string, number | null>;
  edges: { from: string; to: string; on_delete?: string | null; rows?: number | null }[];
  totals: {
    rows_changed?: number | null;
    rows_deleted?: number | null;
    rows_via_cascade?: number | null;
    tables_touched?: number | null;
  };
  metrics: { id?: string | null; name?: string | null; unit?: string | null; before?: number | null; after?: number | null }[];
  guardrails: { passed: number; total: number };
  probes: { label?: string | null; result?: string | null }[];
  secret_scan: { scanned?: number | null; hits?: number | null };
  teardown: { sandbox_listed?: boolean | null; rootfs_exists?: boolean | null; leftover_processes?: number | null };
  prod: { before?: string | null; after?: string | null; unchanged?: boolean | null; measured_from?: string | null };
  /** Facts to sit beside the metrics, where the plan moved something other than money. Not sent by the API. */
  extras?: { name: string; text: string }[];
}

/** One paired comparison over tasks from bench/stats.json: b minus a. */
export interface TaskCompare {
  from?: number;
  to?: number;
  difference?: number;
  ci95?: [number, number];
  excludes_zero?: boolean;
  permutation_p?: number;
  tasks?: number;
}

export interface TaskLevel {
  harm?: TaskCompare;
  done?: TaskCompare;
}

export interface ControlArms {
  tasks?: number;
  arms?: Record<string, { harm?: number; done?: number; tasks?: number }>;
  compare?: Record<string, TaskLevel>;
}

interface EvasionCount {
  total?: number;
  caught?: number;
  by_measured_check?: number;
  by_second_reader?: number;
}

interface EvasionRate {
  plans?: number;
  harmful?: number;
  good?: number;
  harmful_pct?: number | null;
}

/** bench/evasion.json, without its per-plan rows. */
export interface EvasionFacts {
  at?: string;
  model?: string;
  rates?: { passed_first_time?: EvasionRate; passed_after_breaking_a_rule?: EvasionRate; safe_plans?: number; safe_plans_that_broke_a_rule_first?: number };
  detection?: Record<'design' | 'unseen', { plans?: number; harmful?: EvasionCount; good?: EvasionCount; neither?: EvasionCount }>;
  empty_plans?: { plans?: number; harmful?: number; good?: number; neither?: number };
  examples?: {
    task: string;
    request: string;
    attempts: { n: number; verdict?: string; plan?: string[]; broke?: string[] }[];
    harm?: string[];
    second_reader?: string;
    measured?: string[];
  }[];
  after?: Record<string, TaskLevel> & { checked?: number; flagged_at_least_once?: number; stopped?: number; runs?: number } | null;
}

interface Percentiles {
  p50?: number | null;
  p95?: number | null;
  n?: number;
}

/** bench/vultr.json, written by bench/vultr_usage.py from the benchmark's runs files and Vultr's own APIs. */
export interface VultrUsage {
  at?: string;
  rerun?: string;
  read_only?: string;
  benchmark?: { code_sha256?: string; code_matches_checkout?: boolean; files?: { results: string; runs: string; label?: string; planner_model?: string }[] } | null;
  inference?: {
    source?: string;
    base_url?: string;
    base_is_vultr?: boolean;
    runs?: number;
    models_used?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    tokens?: number;
    cost_usd?: number;
    by_model?: { model: string; cost_usd?: number; phases?: string[] }[];
    calls_at_least?: { planner?: number; explainer?: number; evasion_reader?: number; how?: string };
  } | null;
  models?: {
    model: string;
    name?: string | null;
    listed?: boolean;
    usd_per_million_prompt?: number | null;
    usd_per_million_completion?: number | null;
    jobs: { job: string; what?: string; setting?: string; where?: string }[];
  }[] | null;
  catalogue?: { source?: string; models_listed?: number } | null;
  microvms?: {
    source?: string;
    rehearsals?: number;
    reproductions?: number;
    total?: number;
    containment_complete?: number;
    containment_incomplete?: number;
    clone_boot_ms?: Percentiles;
    rehearsal_s?: Percentiles;
    soak?: { rehearsals?: number; all_contained?: boolean } | null;
    redteam?: { attacks?: number; contained?: number } | null;
  } | null;
  postgres?: {
    benchmark?: { source?: string; databases_created?: number; dropped?: number; drop_failed?: number } | null;
    cluster?: {
      source?: string;
      engine?: string;
      version?: string;
      plan?: string;
      region?: string;
      status?: string;
      vcpus?: number;
      ram_mb?: number;
      disk_gb?: number;
      in_vpc?: boolean;
      logical_databases?: number;
    } | null;
  } | null;
  object_storage?: {
    source?: string;
    bucket?: string;
    objects?: number;
    bytes?: number;
    by_prefix?: { prefix: string; objects: number; bytes: number; what?: string | null }[];
  } | null;
  resources?: {
    source?: string;
    count?: number;
    firewall_rules?: number;
    instances?: { label?: string; plan?: string; region?: string; status?: string; vcpu_count?: number; ram?: number; in_vpc?: boolean }[] | null;
    vpcs?: { description?: string; region?: string; v4_subnet?: string; v4_subnet_mask?: number }[] | null;
    firewalls?: { description?: string; rules?: number }[] | null;
  } | null;
  spend?: {
    billed?: { source?: string; total_usd?: number; by_product?: { product: string; usd: number }[]; note?: string } | null;
    budget?: { ceiling_usd?: number; spent_usd?: number; credit_left_usd?: number } | null;
  } | null;
  errors?: Record<string, string>;
}
