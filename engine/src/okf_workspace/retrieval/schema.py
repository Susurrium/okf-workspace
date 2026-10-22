INDEX_SCHEMA_VERSION = 4

INDEX_SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
    path TEXT PRIMARY KEY, file_hash TEXT NOT NULL, modified_ns INTEGER NOT NULL,
    size INTEGER NOT NULL, title TEXT NOT NULL, note_type TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_states (
    path TEXT PRIMARY KEY, modified_ns INTEGER NOT NULL, size INTEGER NOT NULL,
    changed_ns INTEGER NOT NULL, file_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    row_id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE,
    heading TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
    text TEXT NOT NULL, text_hash TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
);
CREATE VIEW IF NOT EXISTS fts_content AS
    SELECT row_id, chunk_id, path, heading, text AS body, search_text FROM chunks;
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
    chunk_id UNINDEXED, path UNINDEXED, heading, body, search_text,
    content='fts_content', content_rowid='row_id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO fts_chunks(rowid, chunk_id, path, heading, body, search_text)
    VALUES (new.row_id, new.chunk_id, new.path, new.heading, new.text, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
    INSERT INTO fts_chunks(fts_chunks, rowid, chunk_id, path, heading, body, search_text)
    VALUES ('delete', old.row_id, old.chunk_id, old.path, old.heading, old.text, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_update AFTER UPDATE ON chunks BEGIN
    INSERT INTO fts_chunks(fts_chunks, rowid, chunk_id, path, heading, body, search_text)
    VALUES ('delete', old.row_id, old.chunk_id, old.path, old.heading, old.text, old.search_text);
    INSERT INTO fts_chunks(rowid, chunk_id, path, heading, body, search_text)
    VALUES (new.row_id, new.chunk_id, new.path, new.heading, new.text, new.search_text);
END;
CREATE TABLE IF NOT EXISTS links (
    source_path TEXT NOT NULL, target_path TEXT NOT NULL, relation TEXT NOT NULL,
    PRIMARY KEY (source_path, target_path, relation)
);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
"""
