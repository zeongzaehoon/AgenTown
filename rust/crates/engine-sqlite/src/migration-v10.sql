-- Caller declarations are bounded untrusted metadata, not authenticated identity.
ALTER TABLE loop_sessions ADD COLUMN declared_source TEXT
 CHECK(declared_source IS NULL OR (length(declared_source) BETWEEN 1 AND 80));
CREATE TRIGGER loop_session_source_immutable BEFORE UPDATE OF declared_source ON loop_sessions
WHEN NEW.declared_source IS NOT OLD.declared_source
BEGIN SELECT RAISE(ABORT,'immutable loop caller declaration'); END;
