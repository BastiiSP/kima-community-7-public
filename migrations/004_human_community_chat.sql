-- Retain historical provenance and migration history; permanently close old keys.
UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, now());

-- Separate from the shared access lock to avoid lock upgrades on deletion.
CREATE TABLE chat_control (
  id integer PRIMARY KEY CHECK (id = 1),
  deletion_revision bigint NOT NULL DEFAULT 0
);
INSERT INTO chat_control (id) VALUES (1);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  author_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX chat_messages_author_idx ON chat_messages(author_id);
