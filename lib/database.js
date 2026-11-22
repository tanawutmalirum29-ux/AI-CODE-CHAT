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
  await pool.query("CREATE TABLE IF NOT EXISTS engine_profiles (" +
    "profile_id UUID PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, " +
    "chat_url TEXT, chat_auth_scheme TEXT NOT NULL DEFAULT 'bearer', chat_timeout_ms INTEGER NOT NULL DEFAULT 120000, " +
    "chat_token_enc TEXT, chat_token_iv TEXT, chat_token_tag TEXT, " +
    "comfy_url TEXT, comfy_auth_scheme TEXT NOT NULL DEFAULT 'bearer', comfy_timeout_ms INTEGER NOT NULL DEFAULT 300000, " +
    "comfy_token_enc TEXT, comfy_token_iv TEXT, comfy_token_tag TEXT, " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE INDEX IF NOT EXISTS engine_profiles_session_idx ON engine_profiles (session_id, created_at)");
}

const ENGINE_COLUMNS = "profile_id, name, chat_url, chat_auth_scheme, chat_timeout_ms, chat_token_enc, chat_token_iv, chat_token_tag, " +
  "comfy_url, comfy_auth_scheme, comfy_timeout_ms, comfy_token_enc, comfy_token_iv, comfy_token_tag";

export async function listEngineRows(pool, sessionId) {
  const result = await pool.query("SELECT " + ENGINE_COLUMNS + " FROM engine_profiles WHERE session_id = $1 ORDER BY created_at", [sessionId]);
  return result.rows;
}

export async function findEngineRow(pool, sessionId, profileId) {
  const result = await pool.query("SELECT " + ENGINE_COLUMNS + " FROM engine_profiles WHERE session_id = $1 AND profile_id = $2", [sessionId, profileId]);
  return result.rows[0] || null;
}

export async function countEngineRows(pool, sessionId) {
  const result = await pool.query("SELECT COUNT(*)::int AS n FROM engine_profiles WHERE session_id = $1", [sessionId]);
  return result.rows[0].n;
}

export async function insertEngineRow(pool, sessionId, row) {
  await pool.query(
    "INSERT INTO engine_profiles (profile_id, session_id, name, chat_url, chat_auth_scheme, chat_timeout_ms, chat_token_enc, chat_token_iv, chat_token_tag, " +
    "comfy_url, comfy_auth_scheme, comfy_timeout_ms, comfy_token_enc, comfy_token_iv, comfy_token_tag) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [row.profile_id, sessionId, row.name, row.chat_url, row.chat_auth_scheme, row.chat_timeout_ms, row.chat_token_enc, row.chat_token_iv, row.chat_token_tag,
      row.comfy_url, row.comfy_auth_scheme, row.comfy_timeout_ms, row.comfy_token_enc, row.comfy_token_iv, row.comfy_token_tag]
  );
}

export async function updateEngineRow(pool, sessionId, row) {
  const result = await pool.query(
    "UPDATE engine_profiles SET name=$3, chat_url=$4, chat_auth_scheme=$5, chat_timeout_ms=$6, chat_token_enc=$7, chat_token_iv=$8, chat_token_tag=$9, " +
    "comfy_url=$10, comfy_auth_scheme=$11, comfy_timeout_ms=$12, comfy_token_enc=$13, comfy_token_iv=$14, comfy_token_tag=$15, updated_at=NOW() " +
    "WHERE session_id=$1 AND profile_id=$2",
    [sessionId, row.profile_id, row.name, row.chat_url, row.chat_auth_scheme, row.chat_timeout_ms, row.chat_token_enc, row.chat_token_iv, row.chat_token_tag,
      row.comfy_url, row.comfy_auth_scheme, row.comfy_timeout_ms, row.comfy_token_enc, row.comfy_token_iv, row.comfy_token_tag]
  );
  return result.rowCount > 0;
}

export async function removeEngineRow(pool, sessionId, profileId) {
  const result = await pool.query("DELETE FROM engine_profiles WHERE session_id = $1 AND profile_id = $2", [sessionId, profileId]);
  return result.rowCount > 0;
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
