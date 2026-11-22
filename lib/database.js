export async function initDatabase(pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS provider_api_keys (" +
    "session_id TEXT NOT NULL, provider_id TEXT NOT NULL, encrypted TEXT NOT NULL, " +
    "iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (session_id, provider_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS project_workspaces (" +
    "workspace_id UUID PRIMARY KEY, session_id TEXT NOT NULL, archive_zip BYTEA NOT NULL, " +
    "original_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE INDEX IF NOT EXISTS project_workspaces_session_idx " +
    "ON project_workspaces (session_id, last_accessed_at DESC)");
}

export async function upsertProviderKey(pool, sessionId, providerId, encrypted) {
  await pool.query(
    "INSERT INTO provider_api_keys (session_id, provider_id, encrypted, iv, tag) VALUES ($1, $2, $3, $4, $5) " +
    "ON CONFLICT (session_id, provider_id) DO UPDATE SET encrypted = EXCLUDED.encrypted, " +
    "iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = NOW()",
    [sessionId, providerId, encrypted.encrypted, encrypted.iv, encrypted.tag]
  );
}

export async function findProviderKey(pool, sessionId, providerId) {
  const result = await pool.query(
    "SELECT encrypted, iv, tag FROM provider_api_keys WHERE session_id = $1 AND provider_id = $2",
    [sessionId, providerId]
  );
  return result.rows[0] || null;
}

export async function removeProviderKey(pool, sessionId, providerId) {
  await pool.query(
    "DELETE FROM provider_api_keys WHERE session_id = $1 AND provider_id = $2",
    [sessionId, providerId]
  );
}
