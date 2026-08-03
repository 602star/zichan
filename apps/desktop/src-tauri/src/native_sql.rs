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
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

type SqliteQuery<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>;
type NativeConnection = Arc<Mutex<PoolConnection<Sqlite>>>;

fn ledger_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("ledger.sqlite"))
        .map_err(|error| error.to_string())
}

#[derive(Default)]
pub struct NativeSqlState {
    pools: Mutex<HashMap<String, SqlitePool>>,
    transactions: Mutex<HashMap<String, NativeConnection>>,
    next_transaction_id: AtomicU64,
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
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
        .map_err(|error| error.to_string())?
        .create_if_missing(true)
        .pragma("key", key_pragma)
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

async fn configure_connection(connection: &mut PoolConnection<Sqlite>) -> Result<(), String> {
    for pragma in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = FULL",
    ] {
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
pub fn native_sql_database_url(app: AppHandle) -> Result<String, String> {
    let path = ledger_database_path(&app)?;
    let parent = path.parent().ok_or("原生数据库路径无效")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建数据库目录 {} 失败：{error}", parent.display()))?;
    // An absolute suffix keeps tauri-plugin-sql from remapping this file to AppConfig.
    Ok(format!("sqlite:{}", path.display()))
}

#[tauri::command]
pub async fn native_sql_open(
    app: AppHandle,
    db: String,
    database_key_hex: String,
    state: State<'_, NativeSqlState>,
) -> Result<(), String> {
    if database_key_hex.len() != 64
        || !database_key_hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("native database key must be 32 lowercase hex bytes".into());
    }
    let expected = native_sql_database_url(app.clone())?;
    if db != expected {
        return Err("native database URL does not match the application data path".into());
    }
    if !state.transactions.lock().await.is_empty() {
        return Err("cannot reopen native database while a transaction is active".into());
    }
    if let Some(existing) = state.pools.lock().await.remove(&db) {
        existing.close().await;
    }

    let path = ledger_database_path(&app)?;
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
    configure_connection(&mut connection).await
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
    configure_connection(&mut connection).await?;
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
    configure_connection(&mut connection).await?;
    select_on_connection(&mut connection, query, values).await
}

#[tauri::command]
pub async fn native_sql_begin(
    db: String,
    state: State<'_, NativeSqlState>,
) -> Result<String, String> {
    let pool = sqlite_pool(&state, &db).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    configure_connection(&mut connection).await?;
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
pub fn native_sql_database_path(app: AppHandle) -> Result<String, String> {
    ledger_database_path(&app).map(|path| path.display().to_string())
}

#[tauri::command]
pub fn native_sql_delete_database(app: AppHandle) -> Result<(), String> {
    let path = ledger_database_path(&app)?;
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
        configure_connection, execute_on_connection, open_encrypted_pool, select_on_connection,
    };
    use serde_json::{Number, Value};
    use sqlx::SqlitePool;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn native_sql_helpers_round_trip() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePool::connect("sqlite::memory:")
                .await
                .expect("open sqlite memory database");
            let mut connection = pool.acquire().await.expect("acquire connection");
            configure_connection(&mut connection)
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
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "zichan-sqlcipher-{}-{nonce}.sqlite",
                std::process::id()
            ));
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

            for candidate in [
                path.clone(),
                path.with_file_name(format!(
                    "{}-wal",
                    path.file_name()
                        .expect("database file name")
                        .to_string_lossy()
                )),
                path.with_file_name(format!(
                    "{}-shm",
                    path.file_name()
                        .expect("database file name")
                        .to_string_lossy()
                )),
            ] {
                if candidate.is_file() {
                    fs::remove_file(candidate).expect("remove SQLCipher test file");
                }
            }
        });
    }
}
