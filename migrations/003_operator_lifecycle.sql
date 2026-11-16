ALTER TABLE members ADD COLUMN blocked_at timestamptz;
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE posts ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE posts ADD CONSTRAINT posts_anonymous_deleted CHECK (author_id IS NOT NULL OR (deleted_at IS NOT NULL AND body = '' AND agent_name IS NULL));

CREATE TABLE community_control (
  id integer PRIMARY KEY CHECK (id = 1),
  paused_at timestamptz
);
INSERT INTO community_control (id) VALUES (1);
