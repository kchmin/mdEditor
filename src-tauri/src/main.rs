#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct StatInfo {
    exists: bool,
    is_dir: bool,
    mtime_ms: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        out.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir: p.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let s = String::from_utf8_lossy(&bytes);
    Ok(s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn stat_path(path: String) -> StatInfo {
    match fs::metadata(&path) {
        Ok(m) => {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            StatInfo {
                exists: true,
                is_dir: m.is_dir(),
                mtime_ms,
            }
        }
        Err(_) => StatInfo {
            exists: false,
            is_dir: false,
            mtime_ms: 0,
        },
    }
}

#[tauri::command]
fn get_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir, read_text, write_text, stat_path, get_args
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
