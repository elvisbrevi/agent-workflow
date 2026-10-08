//! The CLI's run log, read for the history view.
//!
//! The path resolves as the CLI resolves it (ADR-0029): `LAZY_WORKFLOW_LOG_FILE`
//! in the run environment, else `~/.local/state/lazy-workflow/runs.jsonl`. Only
//! the newest records are returned; a line that is not JSON is skipped rather
//! than failing the whole view, as a monitoring tail would.

use crate::settings::home_dir;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunLog {
    pub path: String,
    pub exists: bool,
    pub records: Vec<Value>,
}

pub fn run_log_path(environment: &BTreeMap<String, String>) -> PathBuf {
    match environment.get("LAZY_WORKFLOW_LOG_FILE").map(|value| value.trim()) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home_dir().join(".local").join("state").join("lazy-workflow").join("runs.jsonl"),
    }
}

pub fn read(path: &Path, limit: usize) -> Result<RunLog, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RunLog { path: path.to_string_lossy().into_owned(), exists: false, records: Vec::new() })
        }
        Err(error) => return Err(format!("no se pudo leer {}: {error}", path.display())),
    };
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(limit);
    let records = lines[start..].iter().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect();
    Ok(RunLog { path: path.to_string_lossy().into_owned(), exists: true, records })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_records_and_skips_garbage() {
        let path = std::env::temp_dir().join(format!("lz-gui-run-log-{}.jsonl", std::process::id()));
        std::fs::write(&path, "{\"n\":1}\nnot json\n{\"n\":2}\n{\"n\":3}\n").unwrap();
        let log = read(&path, 3).unwrap();
        assert_eq!(log.records.iter().map(|record| record["n"].as_i64().unwrap()).collect::<Vec<_>>(), vec![2, 3]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_environment_overrides_the_default_path() {
        let environment = BTreeMap::from([("LAZY_WORKFLOW_LOG_FILE".to_string(), "/tmp/x.jsonl".to_string())]);
        assert_eq!(run_log_path(&environment), PathBuf::from("/tmp/x.jsonl"));
        assert!(run_log_path(&BTreeMap::new()).ends_with(".local/state/lazy-workflow/runs.jsonl"));
    }
}
