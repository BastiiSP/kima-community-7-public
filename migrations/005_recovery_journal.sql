-- Applied atomically by migrate.ts as the separate owner, never the runtime role.
-- The lock closes the installation gap with already-running writes.
LOCK TABLE public.members, public.posts, public.comments, public.chat_messages IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.recovery_journal_state (
  id integer PRIMARY KEY CHECK (id = 1),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.recovery_journal_state (id) VALUES (1);

-- Deliberately no content, email, user identifiers, or FK back to deleted rows.
-- Deduplication retains every intent until an explicitly designed retention policy.
CREATE TABLE public.recovery_journal (
  kind text NOT NULL CHECK (kind IN ('member_block', 'member_delete', 'post_delete', 'comment_delete', 'chat_delete')),
  entity_id uuid NOT NULL,
  last_affected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, entity_id)
);

CREATE FUNCTION public.record_recovery_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE intent text;
BEGIN
  IF TG_TABLE_NAME = 'members' THEN
    IF TG_OP = 'DELETE' THEN
      intent := 'member_delete';
    ELSIF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
      INSERT INTO public.recovery_journal (kind, entity_id) VALUES ('member_delete', OLD.id)
        ON CONFLICT (kind, entity_id) DO UPDATE SET last_affected_at = greatest(public.recovery_journal.last_affected_at, clock_timestamp());
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.blocked_at IS NOT NULL THEN
      INSERT INTO public.recovery_journal (kind, entity_id) VALUES ('member_block', NEW.id)
        ON CONFLICT (kind, entity_id) DO UPDATE SET last_affected_at = greatest(public.recovery_journal.last_affected_at, clock_timestamp());
    END IF;
  ELSIF TG_TABLE_NAME = 'posts' THEN
    IF TG_OP = 'DELETE' THEN intent := 'post_delete';
    ELSIF NEW.body IS DISTINCT FROM OLD.body OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
      OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.agent_name IS DISTINCT FROM OLD.agent_name
      OR NEW.id IS DISTINCT FROM OLD.id THEN intent := 'post_delete'; END IF;
  ELSIF TG_TABLE_NAME = 'comments' THEN
    IF TG_OP = 'DELETE' THEN intent := 'comment_delete';
    ELSIF NEW.body IS DISTINCT FROM OLD.body OR NEW.author_id IS DISTINCT FROM OLD.author_id
      OR NEW.agent_name IS DISTINCT FROM OLD.agent_name OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.post_id IS DISTINCT FROM OLD.post_id THEN intent := 'comment_delete'; END IF;
  ELSIF TG_TABLE_NAME = 'chat_messages' THEN
    IF TG_OP = 'DELETE' THEN intent := 'chat_delete';
    ELSIF NEW.body IS DISTINCT FROM OLD.body OR NEW.author_id IS DISTINCT FROM OLD.author_id
      OR NEW.id IS DISTINCT FROM OLD.id THEN intent := 'chat_delete'; END IF;
  END IF;
  IF intent IS NOT NULL THEN
    INSERT INTO public.recovery_journal (kind, entity_id) VALUES (intent, OLD.id)
      ON CONFLICT (kind, entity_id) DO UPDATE SET last_affected_at = greatest(public.recovery_journal.last_affected_at, clock_timestamp());
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.reject_recovery_gap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Only the nested owner-defined content trigger may advance a retained intent.
  -- Direct UPDATE, even as owner, has depth 1 and remains rejected.
  IF TG_TABLE_NAME = 'recovery_journal' AND TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Recovery journal coverage must be preserved' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER recovery_members AFTER INSERT OR UPDATE OR DELETE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.record_recovery_intent();
CREATE TRIGGER recovery_posts AFTER UPDATE OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.record_recovery_intent();
CREATE TRIGGER recovery_comments AFTER UPDATE OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.record_recovery_intent();
CREATE TRIGGER recovery_chat_messages AFTER UPDATE OR DELETE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.record_recovery_intent();

CREATE TRIGGER recovery_no_truncate BEFORE TRUNCATE ON public.members
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
CREATE TRIGGER recovery_no_truncate BEFORE TRUNCATE ON public.posts
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
CREATE TRIGGER recovery_no_truncate BEFORE TRUNCATE ON public.comments
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
CREATE TRIGGER recovery_no_truncate BEFORE TRUNCATE ON public.chat_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
CREATE TRIGGER recovery_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.recovery_journal
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
CREATE TRIGGER recovery_state_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.recovery_journal_state
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();

ALTER TABLE public.members ENABLE ALWAYS TRIGGER recovery_members;
ALTER TABLE public.posts ENABLE ALWAYS TRIGGER recovery_posts;
ALTER TABLE public.comments ENABLE ALWAYS TRIGGER recovery_comments;
ALTER TABLE public.chat_messages ENABLE ALWAYS TRIGGER recovery_chat_messages;
ALTER TABLE public.members ENABLE ALWAYS TRIGGER recovery_no_truncate;
ALTER TABLE public.posts ENABLE ALWAYS TRIGGER recovery_no_truncate;
ALTER TABLE public.comments ENABLE ALWAYS TRIGGER recovery_no_truncate;
ALTER TABLE public.chat_messages ENABLE ALWAYS TRIGGER recovery_no_truncate;
ALTER TABLE public.recovery_journal ENABLE ALWAYS TRIGGER recovery_append_only;
ALTER TABLE public.recovery_journal_state ENABLE ALWAYS TRIGGER recovery_state_immutable;

CREATE TABLE public.recovery_backup_boundaries (
  backup_id text PRIMARY KEY CHECK (length(backup_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL
);
CREATE TRIGGER recovery_boundaries_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.recovery_backup_boundaries
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_recovery_gap();
ALTER TABLE public.recovery_backup_boundaries ENABLE ALWAYS TRIGGER recovery_boundaries_immutable;

-- Run before pg_dump. The same transaction commits this proof and releases the
-- locks. Every earlier mutation has committed; all later mutations are recorded
-- at or after this boundary (including the short overlap before pg_dump starts).
CREATE FUNCTION public.record_recovery_boundary(backup_id text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE started timestamptz;
BEGIN
  IF backup_id NOT LIKE 'database-%' OR length(backup_id) > 200 THEN
    RAISE EXCEPTION 'Invalid recovery backup identifier' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.members, public.posts, public.comments, public.chat_messages IN SHARE MODE;
  -- Floor to milliseconds for the existing authenticated JSON header. At most
  -- one millisecond of additional conservative overlap; never a missing tail.
  started := date_trunc('milliseconds', clock_timestamp());
  INSERT INTO public.recovery_backup_boundaries VALUES (backup_id, started);
  RETURN started;
END;
$$;

-- No permanent owner connection is needed by the remote backup runner.
-- Provisioning grants EXECUTE solely to the dedicated backup role afterwards.
-- VOLATILE (the default) obtains fresh query snapshots after the lock wait.
CREATE FUNCTION public.export_recovery_journal(backup_id text, backup_started_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE installed timestamptz; guards integer; snapshot jsonb;
BEGIN
  LOCK TABLE public.members, public.posts, public.comments, public.chat_messages,
    public.recovery_journal, public.recovery_journal_state, public.recovery_backup_boundaries IN SHARE MODE;
  SELECT installed_at INTO installed FROM public.recovery_journal_state WHERE id=1;
  IF installed IS NULL OR backup_started_at IS NULL OR installed > backup_started_at THEN
    RAISE EXCEPTION 'Recovery journal does not cover this backup' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recovery_backup_boundaries b WHERE b.backup_id = export_recovery_journal.backup_id AND b.started_at = backup_started_at) THEN
    RAISE EXCEPTION 'Backup has no verified journal boundary' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO guards FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND t.tgenabled='A' AND (c.relname, t.tgname) IN (
      ('members','recovery_members'), ('posts','recovery_posts'), ('comments','recovery_comments'),
      ('chat_messages','recovery_chat_messages'), ('members','recovery_no_truncate'),
      ('posts','recovery_no_truncate'), ('comments','recovery_no_truncate'),
      ('chat_messages','recovery_no_truncate'), ('recovery_journal','recovery_append_only'),
      ('recovery_journal_state','recovery_state_immutable'), ('recovery_backup_boundaries','recovery_boundaries_immutable'));
  IF guards <> 11 THEN
    RAISE EXCEPTION 'Recovery journal coverage is not intact' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('installed_at', installed, 'reviewed_through', clock_timestamp(),
    'entries', COALESCE((SELECT jsonb_agg(j ORDER BY j.kind, j.entity_id) FROM public.recovery_journal j
      WHERE j.kind = 'member_block' OR j.last_affected_at >= backup_started_at), '[]'::jsonb))
    INTO snapshot;
  RETURN snapshot;
END;
$$;

CREATE TABLE public.backup_health (
  id integer PRIMARY KEY CHECK (id = 1),
  last_verified_at timestamptz,
  backup_id text,
  CHECK ((last_verified_at IS NULL) = (backup_id IS NULL))
);
INSERT INTO public.backup_health (id) VALUES (1);

-- Remove default-privilege grants as well as PUBLIC. Runtime grants for application
-- tables must use an explicit allowlist; backup_health SELECT is granted separately.
DO $$
DECLARE object record; grantee record;
BEGIN
  FOR object IN SELECT c.oid, c.relname, c.relowner, c.relacl FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('recovery_journal', 'recovery_journal_state', 'recovery_backup_boundaries', 'backup_health')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', object.relname);
    FOR grantee IN SELECT DISTINCT r.rolname FROM aclexplode(object.relacl) a
      JOIN pg_roles r ON r.oid = a.grantee WHERE a.grantee <> object.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', object.relname, grantee.rolname);
    END LOOP;
  END LOOP;
  FOR object IN SELECT p.oid, p.proname, p.proowner, p.proacl, pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('record_recovery_intent', 'reject_recovery_gap', 'export_recovery_journal', 'record_recovery_boundary')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC', object.proname, object.arguments);
    FOR grantee IN SELECT DISTINCT r.rolname FROM aclexplode(object.proacl) a
      JOIN pg_roles r ON r.oid = a.grantee WHERE a.grantee <> object.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM %I', object.proname, object.arguments, grantee.rolname);
    END LOOP;
  END LOOP;
END;
$$;
