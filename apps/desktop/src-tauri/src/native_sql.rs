use crate::portable::PortablePaths;
use serde_json::{Map, Number, Value};
use sqlx::{
    pool::PoolConnection,
    sqlite::{
        SqliteArguments, SqliteConnectOptions, SqlitePoolOptions, SqliteQueryResult, SqliteRow,
    },
    Column, ConnectOptions, Row, Sqlite, SqlitePool, TypeInfo, ValueRef,
};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::State;
use tokio::sync::Mutex;

type SqliteQuery<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>;
type NativeConnection = Arc<Mutex<PoolConnection<Sqlite>>>;

fn ledger_database_path(paths: &PortablePaths) -> PathBuf {
    paths.ledger_database.clone()
}

fn database_url(paths: &PortablePaths) -> Result<String, String> {
    let path = ledger_database_path(paths);
    let parent = path.parent().ok_or("原生数据库路径无效")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建数据库目录 {} 失败：{error}", parent.display()))?;
    Ok(format!("sqlite:{}", path.display()))
}

#[derive(Default)]
pub struct NativeSqlState {
    pools: Mutex<HashMap<String, SqlitePool>>,
    transactions: Mutex<HashMap<String, NativeConnection>>,
    next_transaction_id: AtomicU64,
}

impl NativeSqlState {
    pub async fn has_open_database(&self) -> bool {
        !self.pools.lock().await.is_empty() || !self.transactions.lock().await.is_empty()
    }
}

async fn transaction_connection(
    state: &NativeSqlState,
    transaction_id: &str,
) -> Result<NativeConnection, String> {
    state
        .transactions
        .lock()
        .await
        .get(transaction_id)
        .cloned()
        .ok_or_else(|| "native SQL transaction is not active".into())
}

fn bind_values<'q>(
    mut query: SqliteQuery<'q>,
    values: Vec<Value>,
) -> Result<SqliteQuery<'q>, String> {
    for value in values {
        query = match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::String(value) => query.bind(value),
            Value::Bool(value) => query.bind(if value { 1_i64 } else { 0_i64 }),
            Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_u64() {
                    query.bind(i64::try_from(value).map_err(|_| "SQL integer is out of range")?)
                } else {
                    query.bind(value.as_f64().ok_or("SQL number is invalid")?)
                }
            }
            _ => {
                return Err("SQL parameters only support null, string, number, and boolean".into())
            }
        };
    }
    Ok(query)
}

fn decode_row(row: &SqliteRow) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index).map_err(|error| error.to_string())?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" => Value::Number(Number::from(
                    row.try_get::<i64, _>(index)
                        .map_err(|error| error.to_string())?,
                )),
                "REAL" => Number::from_f64(
                    row.try_get::<f64, _>(index)
                        .map_err(|error| error.to_string())?,
                )
                .map(Value::Number)
                .unwrap_or(Value::Null),
                "BLOB" => Value::Array(
                    row.try_get::<Vec<u8>, _>(index)
                        .map_err(|error| error.to_string())?
                        .into_iter()
                        .map(|byte| Value::Number(Number::from(byte)))
                        .collect(),
                ),
                _ => Value::String(
                    row.try_get::<String, _>(index)
                        .map_err(|error| error.to_string())?,
                ),
            }
        };
        result.insert(column.name().to_string(), value);
    }
    Ok(result)
}

async fn sqlite_pool(state: &NativeSqlState, db: &str) -> Result<SqlitePool, String> {
    state
        .pools
        .lock()
        .await
        .get(db)
        .cloned()
        .ok_or_else(|| format!("native encrypted ledger database is not loaded: {db}"))
}

async fn open_encrypted_pool(path: &Path, database_key_hex: &str) -> Result<SqlitePool, String> {
    let key_pragma = format!("\"x'{database_key_hex}'\"");
    // PortablePaths is canonicalized before use. On Windows that can produce a
    // verbatim `\\\\?\\D:\\...` path, whose `?` must never be interpolated into a
    // SQLite URL: SQLx would parse the rest as URL query parameters. Give SQLx
    // the filesystem path directly so ordinary and verbatim Windows paths are
    // both handled as paths.
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .pragma("key", key_pragma)
        .pragma("temp_store", "MEMORY")
        .disable_statement_logging();
    let pool = SqlitePoolOptions::new()
        .min_connections(1)
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(|error| format!("open encrypted SQLite failed: {error}"))?;

    let verification = async {
        let cipher_version = sqlx::query_scalar::<_, String>("PRAGMA cipher_version")
            .fetch_optional(&pool)
            .await
            .map_err(|error| format!("check SQLCipher support failed: {error}"))?
            .unwrap_or_default();
        if cipher_version.trim().is_empty() {
            return Err("this desktop build does not include SQLCipher".into());
        }
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master")
            .fetch_one(&pool)
            .await
            .map_err(|error| {
                format!("database key is wrong or encrypted database is damaged: {error}")
            })?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = verification {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

async fn configure_read_connection(connection: &mut PoolConnection<Sqlite>) -> Result<(), String> {
    // These are connection-local. Keep schema inspection read-only so rejecting
    // a development-era database cannot rewrite its header or create WAL files.
    for pragma in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA temp_store = MEMORY",
    ] {
        sqlx::query(pragma)
            .execute(&mut **connection)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn configure_write_connection(connection: &mut PoolConnection<Sqlite>) -> Result<(), String> {
    configure_read_connection(connection).await?;
    for pragma in ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL"] {
        sqlx::query(pragma)
            .execute(&mut **connection)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn execute_on_connection(
    connection: &mut PoolConnection<Sqlite>,
    query: String,
    values: Vec<Value>,
) -> Result<SqliteQueryResult, String> {
    bind_values(sqlx::query(&query), values)?
        .execute(&mut **connection)
        .await
        .map_err(|error| error.to_string())
}

async fn select_on_connection(
    connection: &mut PoolConnection<Sqlite>,
    query: String,
    values: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let rows = bind_values(sqlx::query(&query), values)?
        .fetch_all(&mut **connection)
        .await
        .map_err(|error| error.to_string())?;
    rows.iter().map(decode_row).collect()
}

#[tauri::command]
pub fn native_sql_database_url(paths: State<'_, PortablePaths>) -> Result<String, String> {
    database_url(&paths)
}

#[tauri::command]
pub async fn native_sql_open(
    db: String,
    database_key_hex: String,
    state: State<'_, NativeSqlState>,
    paths: State<'_, PortablePaths>,
) -> Result<(), String> {
    if database_key_hex.len() != 64
        || !database_key_hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("native database key must be 32 lowercase hex bytes".into());
    }
    let expected = database_url(&paths)?;
    if db != expected {
        return Err("native database URL does not match the application data path".into());
    }
    if !state.transactions.lock().await.is_empty() {
        return Err("cannot reopen native database while a transaction is active".into());
    }
    if let Some(existing) = state.pools.lock().await.remove(&db) {
        existing.close().await;
    }

    let path = ledger_database_path(&paths);
    let pool = open_encrypted_pool(&path, &database_key_hex).await?;
    state.pools.lock().await.insert(db, pool);
    Ok(())
}

#[tauri::command]
pub async fn native_sql_close(db: String, state: State<'_, NativeSqlState>) -> Result<(), String> {
    if !state.transactions.lock().await.is_empty() {
        return Err("cannot close native database while a transaction is active".into());
    }
    if let Some(pool) = state.pools.lock().await.remove(&db) {
        pool.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn native_sql_prepare(
    db: String,
    state: State<'_, NativeSqlState>,
) -> Result<(), String> {
    let pool = sqlite_pool(&state, &db).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    configure_read_connection(&mut connection).await
}

#[tauri::command]
pub async fn native_sql_execute(
    db: String,
    query: String,
    values: Vec<Value>,
    transaction_id: Option<String>,
    state: State<'_, NativeSqlState>,
) -> Result<u64, String> {
    if let Some(transaction_id) = transaction_id {
        let connection = transaction_connection(&state, &transaction_id).await?;
        let mut connection = connection.lock().await;
        return execute_on_connection(&mut connection, query, values)
            .await
            .map(|result| result.rows_affected());
    }
    let pool = sqlite_pool(&state, &db).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    configure_write_connection(&mut connection).await?;
    execute_on_connection(&mut connection, query, values)
        .await
        .map(|result| result.rows_affected())
}

#[tauri::command]
pub async fn native_sql_select(
    db: String,
    query: String,
    values: Vec<Value>,
    transaction_id: Option<String>,
    state: State<'_, NativeSqlState>,
) -> Result<Vec<Map<String, Value>>, String> {
    if let Some(transaction_id) = transaction_id {
        let connection = transaction_connection(&state, &transaction_id).await?;
        let mut connection = connection.lock().await;
        return select_on_connection(&mut connection, query, values).await;
    }
    let pool = sqlite_pool(&state, &db).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    configure_read_connection(&mut connection).await?;
    select_on_connection(&mut connection, query, values).await
}

#[tauri::command]
pub async fn native_sql_begin(
    db: String,
    state: State<'_, NativeSqlState>,
) -> Result<String, String> {
    let pool = sqlite_pool(&state, &db).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    configure_write_connection(&mut connection).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    let id = format!(
        "native-tx-{}",
        state.next_transaction_id.fetch_add(1, Ordering::Relaxed) + 1
    );
    state
        .transactions
        .lock()
        .await
        .insert(id.clone(), Arc::new(Mutex::new(connection)));
    Ok(id)
}

async fn finish_transaction(
    state: &NativeSqlState,
    transaction_id: String,
    statement: &str,
) -> Result<(), String> {
    let connection = state
        .transactions
        .lock()
        .await
        .remove(&transaction_id)
        .ok_or("native SQL transaction is not active")?;
    let mut connection = connection.lock().await;
    sqlx::query(statement)
        .execute(&mut **connection)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn native_sql_commit(
    transaction_id: String,
    state: State<'_, NativeSqlState>,
) -> Result<(), String> {
    finish_transaction(&state, transaction_id, "COMMIT").await
}

#[tauri::command]
pub async fn native_sql_rollback(
    transaction_id: String,
    state: State<'_, NativeSqlState>,
) -> Result<(), String> {
    finish_transaction(&state, transaction_id, "ROLLBACK").await
}

#[tauri::command]
pub fn native_sql_database_path(paths: State<'_, PortablePaths>) -> String {
    ledger_database_path(&paths).display().to_string()
}

#[tauri::command]
pub fn native_sql_delete_database(paths: State<'_, PortablePaths>) -> Result<(), String> {
    let path = ledger_database_path(&paths);
    for candidate in [
        path.clone(),
        path.with_file_name("ledger.sqlite-wal"),
        path.with_file_name("ledger.sqlite-shm"),
    ] {
        if candidate.is_file() {
            fs::remove_file(&candidate)
                .map_err(|error| format!("删除数据库 {} 失败：{error}", candidate.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        configure_read_connection, configure_write_connection, execute_on_connection,
        open_encrypted_pool, select_on_connection,
    };
    use serde_json::{Number, Value};
    use sqlx::SqlitePool;
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SchemaContract {
        schema_version: i64,
        schema_name: String,
        migration_table_sql: String,
        statements: Vec<String>,
    }

    fn temporary_database_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        env::temp_dir().join(format!(
            "zichan-{label}-{}-{nonce}.sqlite",
            std::process::id()
        ))
    }

    fn temporary_database_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("zichan-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).expect("create SQLCipher test directory");
        directory
            .canonicalize()
            .expect("canonicalize SQLCipher test directory")
    }

    fn remove_sqlite_files(path: &std::path::Path) {
        for candidate in [
            path.to_path_buf(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            if candidate.is_file() {
                fs::remove_file(candidate).expect("remove SQLCipher contract test file");
            }
        }
    }

    #[test]
    fn native_sql_helpers_round_trip() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePool::connect("sqlite::memory:")
                .await
                .expect("open sqlite memory database");
            let mut connection = pool.acquire().await.expect("acquire connection");
            configure_write_connection(&mut connection)
                .await
                .expect("configure connection");
            execute_on_connection(
                &mut connection,
                "CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT, amount REAL)".into(),
                Vec::new(),
            )
            .await
            .expect("create table");
            execute_on_connection(
                &mut connection,
                "INSERT INTO sample (id, name, amount) VALUES (?, ?, ?)".into(),
                vec![
                    Value::Number(Number::from(1)),
                    Value::String("ledger".into()),
                    Value::Number(Number::from_f64(12.5).expect("number")),
                ],
            )
            .await
            .expect("insert row");
            let rows = select_on_connection(
                &mut connection,
                "SELECT id, name, amount FROM sample".into(),
                Vec::new(),
            )
            .await
            .expect("select row");
            assert_eq!(rows[0]["id"], Value::Number(Number::from(1)));
            assert_eq!(rows[0]["name"], Value::String("ledger".into()));
            assert_eq!(
                rows[0]["amount"],
                Value::Number(Number::from_f64(12.5).expect("number"))
            );
        });
    }

    #[test]
    fn sqlcipher_encrypts_the_file_and_rejects_the_wrong_key() {
        tauri::async_runtime::block_on(async {
            let path = temporary_database_path("sqlcipher");
            let key = "11".repeat(32);
            let wrong_key = "22".repeat(32);

            let pool = open_encrypted_pool(&path, &key)
                .await
                .expect("create encrypted database");
            sqlx::query("CREATE TABLE secret (value TEXT NOT NULL)")
                .execute(&pool)
                .await
                .expect("create encrypted table");
            sqlx::query("INSERT INTO secret (value) VALUES ('protected')")
                .execute(&pool)
                .await
                .expect("write encrypted row");
            pool.close().await;

            let bytes = fs::read(&path).expect("read encrypted database");
            assert!(!bytes.starts_with(b"SQLite format 3\0"));

            let reopened = open_encrypted_pool(&path, &key)
                .await
                .expect("reopen with the same key");
            let value = sqlx::query_scalar::<_, String>("SELECT value FROM secret")
                .fetch_one(&reopened)
                .await
                .expect("read encrypted row");
            assert_eq!(value, "protected");
            reopened.close().await;

            let wrong = open_encrypted_pool(&path, &wrong_key).await;
            assert!(wrong.is_err(), "a wrong key must not open the database");

            remove_sqlite_files(&path);
        });
    }

    #[test]
    fn sqlcipher_opens_a_canonicalized_database_path() {
        tauri::async_runtime::block_on(async {
            let directory = temporary_database_directory("canonical-path");
            let path = directory.join("ledger.sqlite");
            let key = "55".repeat(32);
            #[cfg(windows)]
            assert!(
                path.to_string_lossy().starts_with(r"\\?\"),
                "Windows canonical paths must exercise the verbatim-path case: {}",
                path.display()
            );

            let pool = open_encrypted_pool(&path, &key)
                .await
                .expect("open SQLCipher database through a canonicalized path");
            sqlx::query("CREATE TABLE canonical_path_check (value TEXT NOT NULL)")
                .execute(&pool)
                .await
                .expect("write canonical-path database");
            sqlx::query("INSERT INTO canonical_path_check (value) VALUES ('ok')")
                .execute(&pool)
                .await
                .expect("insert canonical-path database row");
            pool.close().await;

            let reopened = open_encrypted_pool(&path, &key)
                .await
                .expect("reopen SQLCipher database through a canonicalized path");
            let value = sqlx::query_scalar::<_, String>("SELECT value FROM canonical_path_check")
                .fetch_one(&reopened)
                .await
                .expect("read canonical-path database row");
            assert_eq!(value, "ok");
            reopened.close().await;

            remove_sqlite_files(&path);
            fs::remove_dir_all(&directory).expect("remove SQLCipher test directory");
        });
    }

    #[test]
    fn read_only_schema_inspection_does_not_rewrite_a_legacy_sqlcipher_file() {
        tauri::async_runtime::block_on(async {
            let path = temporary_database_path("legacy-read-only");
            let key = "44".repeat(32);
            let pool = open_encrypted_pool(&path, &key)
                .await
                .expect("create legacy encrypted database");
            sqlx::query("CREATE TABLE legacy_assets (id TEXT PRIMARY KEY, amount TEXT NOT NULL)")
                .execute(&pool)
                .await
                .expect("create legacy table");
            sqlx::query("INSERT INTO legacy_assets (id, amount) VALUES ('old', '123.45')")
                .execute(&pool)
                .await
                .expect("write legacy row");
            pool.close().await;
            let before = fs::read(&path).expect("read legacy database before inspection");

            let reopened = open_encrypted_pool(&path, &key)
                .await
                .expect("reopen legacy database");
            let mut connection = reopened.acquire().await.expect("acquire read connection");
            configure_read_connection(&mut connection)
                .await
                .expect("configure read-only inspection");
            let tables = sqlx::query_scalar::<_, String>(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            )
            .fetch_all(&mut *connection)
            .await
            .expect("inspect legacy tables");
            assert_eq!(tables, vec!["legacy_assets"]);
            drop(connection);
            reopened.close().await;

            let after = fs::read(&path).expect("read legacy database after inspection");
            assert_eq!(after, before);
            assert!(!PathBuf::from(format!("{}-wal", path.display())).exists());
            assert!(!PathBuf::from(format!("{}-shm", path.display())).exists());
            remove_sqlite_files(&path);
        });
    }

    #[test]
    #[ignore = "requires a schema contract exported from the built @zichan/db package"]
    fn generated_schema_contract_executes_on_sqlcipher() {
        tauri::async_runtime::block_on(async {
            let contract_path = env::var("ZICHAN_SCHEMA_CONTRACT_PATH")
                .expect("ZICHAN_SCHEMA_CONTRACT_PATH must point to the generated contract");
            let contract: SchemaContract = serde_json::from_str(
                &fs::read_to_string(&contract_path).expect("read generated schema contract"),
            )
            .expect("decode generated schema contract");
            assert!(contract.schema_version > 0);
            assert!(!contract.schema_name.trim().is_empty());
            assert!(!contract.statements.is_empty());

            let path = temporary_database_path("schema-contract");
            let pool = open_encrypted_pool(&path, &"33".repeat(32))
                .await
                .expect("open SQLCipher schema contract database");
            let mut transaction = pool.begin().await.expect("begin schema transaction");
            sqlx::raw_sql(&contract.migration_table_sql)
                .execute(&mut *transaction)
                .await
                .expect("create schema migrations table");
            for statement in &contract.statements {
                sqlx::raw_sql(statement)
                    .execute(&mut *transaction)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("execute generated schema statement: {error}\n{statement}")
                    });
            }
            sqlx::query(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            )
            .bind(contract.schema_version)
            .bind(&contract.schema_name)
            .bind("2026-08-13T00:00:00.000Z")
            .execute(&mut *transaction)
            .await
            .expect("record schema baseline");
            transaction
                .commit()
                .await
                .expect("commit schema transaction");

            let marker =
                sqlx::query_as::<_, (i64, String)>("SELECT version, name FROM schema_migrations")
                    .fetch_one(&pool)
                    .await
                    .expect("read schema marker");
            assert_eq!(marker, (contract.schema_version, contract.schema_name));

            sqlx::query(
                "INSERT INTO accounts (id, version, is_deleted, name, kind) VALUES ('bank', 1, 0, 'Bank', 'bank')",
            )
            .execute(&pool)
            .await
            .expect("insert dashboard account");
            for statement in [
                "INSERT INTO transactions (id, version, is_deleted, date, type, category, amount, asset_id, account_id, record_state, reporting_treatment, tag_ids, description) VALUES ('expense', 1, 0, '2026-08-01', 'expense', 'food', '9007199254740992.02', 'CNY', 'bank', 'active', 'ordinary', '[\"work\"]', 'Contract Coffee')",
                "INSERT INTO transactions (id, version, is_deleted, date, type, category, amount, asset_id, record_state, reporting_treatment, tag_ids, description) VALUES ('income', 1, 0, '2026-08-02', 'income', 'salary', '9.00719925474099202e+15', 'CNY', 'active', 'ordinary', '[]', 'Contract Salary')",
            ] {
                sqlx::query(statement)
                    .execute(&pool)
                    .await
                    .expect("insert schema compatibility transaction");
            }

            // This is the Dashboard read model's critical JSON/string shape:
            // monetary values remain TEXT all the way through json_group_array.
            let amounts_json = sqlx::query_scalar::<_, String>(
                "WITH dashboard_postings AS (\
                   SELECT t.asset_id, CASE \
                     WHEN t.type IN ('income', 'refund') THEN t.amount \
                     WHEN t.type = 'adjustment' AND t.adjustment_direction <> 'decrease' THEN t.amount \
                     ELSE CASE WHEN substr(t.amount, 1, 1) = '-' THEN t.amount ELSE '-' || t.amount END \
                   END AS posting_amount \
                   FROM transactions t \
                   WHERE t.is_deleted = 0 AND COALESCE(t.record_state, 'active') = 'active' \
                 ) \
                 SELECT json_group_array(posting_amount) FROM dashboard_postings WHERE asset_id = 'CNY'",
            )
            .fetch_one(&pool)
            .await
            .expect("execute Dashboard JSON aggregate");
            let mut amounts: Vec<String> =
                serde_json::from_str(&amounts_json).expect("decode Dashboard amount strings");
            amounts.sort();
            assert_eq!(
                amounts,
                vec![
                    "-9007199254740992.02".to_string(),
                    "9.00719925474099202e+15".to_string(),
                ]
            );

            let tagged = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM transactions t, json_each(COALESCE(t.tag_ids, '[]')) tag \
                 WHERE tag.value = 'work' \
                   AND INSTR(LOWER(COALESCE(t.description, '')), 'coffee') > 0",
            )
            .fetch_one(&pool)
            .await
            .expect("execute JSON1 and string compatibility query");
            assert_eq!(tagged, 1);

            pool.close().await;
            let bytes = fs::read(&path).expect("read encrypted schema contract database");
            assert!(!bytes.starts_with(b"SQLite format 3\0"));
            remove_sqlite_files(&path);
        });
    }
}
