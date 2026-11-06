-- Blast-radius capture, installed only inside the disposable clone. Prod never sees this file.
-- Runs as the superuser. The plan runs as the unprivileged role `agent`, which owns the app
-- tables but has no access to schema `shadow`, so a plan cannot read or edit its own record.
CREATE SCHEMA IF NOT EXISTS shadow AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA shadow FROM PUBLIC;

-- Which plan step is running. Written by the driver's separate superuser session between steps.
-- Plans cannot spoof attribution with set_config because they cannot write this table.
CREATE TABLE shadow.ctl (id int PRIMARY KEY DEFAULT 1, step int NOT NULL DEFAULT 0);
INSERT INTO shadow.ctl (step) VALUES (0);

CREATE TABLE shadow.changes (
  seq         bigserial PRIMARY KEY,
  step        int NOT NULL,
  relid       oid NOT NULL,
  tbl         text NOT NULL,
  op          text NOT NULL,        -- INSERT | UPDATE | DELETE | TRUNCATE
  depth       int NOT NULL,         -- 1 = the plan's own statement, 2+ = FK cascade or app trigger
  n           bigint NOT NULL DEFAULT 1,  -- rows covered (more than 1 only for TRUNCATE)
  old_row     jsonb,
  new_row     jsonb,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE shadow.ddl (
  seq         bigserial PRIMARY KEY,
  step        int NOT NULL,
  tag         text NOT NULL,
  object_type text,
  identity    text,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION shadow.current_step() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$ SELECT step FROM shadow.ctl WHERE id = 1 $$;

CREATE FUNCTION shadow.capture_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$
BEGIN
  INSERT INTO shadow.changes (step, relid, tbl, op, depth, old_row, new_row)
  VALUES (
    shadow.current_step(), TG_RELID, TG_TABLE_NAME, TG_OP, pg_trigger_depth(),
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION shadow.capture_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$
DECLARE c bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO c;
  INSERT INTO shadow.changes (step, relid, tbl, op, depth, n)
  VALUES (shadow.current_step(), TG_RELID, TG_TABLE_NAME, 'TRUNCATE', pg_trigger_depth(), c);
  RETURN NULL;
END $$;

CREATE FUNCTION shadow.attach(rel regclass) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER zz_shadow_row BEFORE INSERT OR UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION shadow.capture_row()', rel);
  EXECUTE format(
    'CREATE TRIGGER zz_shadow_truncate BEFORE TRUNCATE ON %s
       FOR EACH STATEMENT EXECUTE FUNCTION shadow.capture_truncate()', rel);
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'shadow')
      AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
  LOOP
    PERFORM shadow.attach(r.rel);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA shadow TO agent;
REVOKE ALL ON ALL TABLES IN SCHEMA shadow FROM agent;

-- Event triggers need superuser, so a plan cannot disable them. They record every DDL command
-- and attach capture to any table the plan creates, so rows written to new tables are counted.
CREATE FUNCTION shadow.on_ddl_end() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF r.schema_name = 'shadow' OR r.schema_name LIKE 'pg_temp%' THEN CONTINUE; END IF;
    -- Capture's own triggers on tables the plan creates are ours, not the plan's.
    IF r.object_identity LIKE 'zz_shadow_%' THEN CONTINUE; END IF;
    INSERT INTO shadow.ddl (step, tag, object_type, identity)
    VALUES (shadow.current_step(), r.command_tag, r.object_type, r.object_identity);
    IF r.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') AND r.object_type = 'table' THEN
      PERFORM shadow.attach(r.objid::regclass);
    END IF;
  END LOOP;
END $$;
CREATE EVENT TRIGGER shadow_ddl_end ON ddl_command_end EXECUTE FUNCTION shadow.on_ddl_end();

CREATE FUNCTION shadow.on_sql_drop() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, shadow
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    IF r.schema_name = 'shadow' OR r.schema_name LIKE 'pg_temp%' OR r.schema_name LIKE 'pg_toast%' OR r.is_temporary THEN CONTINUE; END IF;
    IF r.object_type IN ('table', 'table column', 'index', 'view', 'schema', 'sequence', 'function') THEN
      INSERT INTO shadow.ddl (step, tag, object_type, identity)
      VALUES (shadow.current_step(), 'DROP', r.object_type, r.object_identity);
    END IF;
  END LOOP;
END $$;
CREATE EVENT TRIGGER shadow_sql_drop ON sql_drop EXECUTE FUNCTION shadow.on_sql_drop();

