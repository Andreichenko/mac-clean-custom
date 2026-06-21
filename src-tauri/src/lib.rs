use serde::Serialize;
use sysinfo::{CpuExt, ProcessExt, System, SystemExt, PidExt};
use std::path::{Path, PathBuf};
use std::fs;

#[derive(Serialize)]
struct SystemStats {
    total_memory: u64,
    used_memory: u64,
    cpu_global_usage: f32,
    process_count: usize,
    zombie_count: usize,
}

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    cpu_usage: f32,
    memory_usage: u64,
    status: String,
}

#[derive(Serialize)]
struct GarbageFolderInfo {
    id: String,
    name: String,
    path: String,
    size: u64,
    file_count: usize,
}

#[derive(Serialize)]
struct LargeFileInfo {
    name: String,
    path: String,
    size: u64,
}

fn get_dir_size<P: AsRef<Path>>(path: P) -> (u64, usize) {
    let mut size = 0;
    let mut file_count = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_dir() {
                    let (sub_size, sub_count) = get_dir_size(entry.path());
                    size += sub_size;
                    file_count += sub_count;
                } else {
                    size += metadata.len();
                    file_count += 1;
                }
            }
        }
    }
    (size, file_count)
}

fn clean_dir_contents<P: AsRef<Path>>(path: P) -> std::io::Result<u64> {
    let mut bytes_freed = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(metadata) = entry.metadata() {
                let size = if metadata.is_dir() {
                    let (s, _) = get_dir_size(&path);
                    let _ = fs::remove_dir_all(&path);
                    s
                } else {
                    let s = metadata.len();
                    let _ = fs::remove_file(&path);
                    s
                };
                bytes_freed += size;
            }
        }
    }
    Ok(bytes_freed)
}

fn find_large_files_rec(path: &Path, min_size: u64, files: &mut Vec<LargeFileInfo>, depth: usize) {
    if depth > 6 {
        return;
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path_buf = entry.path();
            if let Some(name) = path_buf.file_name().map(|n| n.to_string_lossy()) {
                if name.starts_with('.') || name == "Library" || name == "Applications" {
                    continue;
                }
            }
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_dir() {
                    find_large_files_rec(&path_buf, min_size, files, depth + 1);
                } else {
                    let size = metadata.len();
                    if size >= min_size {
                        files.push(LargeFileInfo {
                            name: path_buf.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                            path: path_buf.to_string_lossy().into_owned(),
                            size,
                        });
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn get_system_stats() -> SystemStats {
    let mut sys = System::new_all();
    sys.refresh_all();
    
    // Brief sleep to allow accurate CPU load reading
    std::thread::sleep(std::time::Duration::from_millis(150));
    sys.refresh_cpu();

    let total_memory = sys.total_memory();
    let used_memory = sys.used_memory();
    let cpu_global_usage = sys.global_cpu_info().cpu_usage();
    let process_count = sys.processes().len();
    
    let zombie_count = sys.processes().values()
        .filter(|p| format!("{:?}", p.status()) == "Zombie")
        .count();

    SystemStats {
        total_memory,
        used_memory,
        cpu_global_usage,
        process_count,
        zombie_count,
    }
}

#[tauri::command]
fn get_processes() -> Vec<ProcessInfo> {
    let mut sys = System::new_all();
    sys.refresh_all();
    
    std::thread::sleep(std::time::Duration::from_millis(150));
    sys.refresh_cpu_and_processes();

    sys.processes().values().map(|p| {
        ProcessInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string(),
            cpu_usage: p.cpu_usage(),
            memory_usage: p.memory(),
            status: format!("{:?}", p.status()),
        }
    }).collect()
}

#[tauri::command]
fn kill_process(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes();
    if let Some(process) = sys.process(sysinfo::Pid::from(pid as usize)) {
        process.kill()
    } else {
        false
    }
}

#[tauri::command]
fn scan_garbage_folders() -> Vec<GarbageFolderInfo> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return vec![];
    }

    let targets = vec![
        ("user_caches", "User Caches", format!("{}/Library/Caches", home)),
        ("user_logs", "User Logs", format!("{}/Library/Logs", home)),
        ("trash", "Trash Bin", format!("{}/.Trash", home)),
        ("xcode_derived", "Xcode Derived Data", format!("{}/Library/Developer/Xcode/DerivedData", home)),
        ("homebrew_cache", "Homebrew Cache", format!("{}/Library/Caches/Homebrew", home)),
    ];

    targets.into_iter().map(|(id, name, path_str)| {
        let path = Path::new(&path_str);
        let (size, file_count) = if path.exists() {
            get_dir_size(path)
        } else {
            (0, 0)
        };
        GarbageFolderInfo {
            id: id.to_string(),
            name: name.to_string(),
            path: path_str,
            size,
            file_count,
        }
    }).collect()
}

#[tauri::command]
fn clean_garbage(folders: Vec<String>) -> u64 {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return 0;
    }

    let mut bytes_freed = 0;
    for id in folders {
        let path_str = match id.as_str() {
            "user_caches" => format!("{}/Library/Caches", home),
            "user_logs" => format!("{}/Library/Logs", home),
            "trash" => format!("{}/.Trash", home),
            "xcode_derived" => format!("{}/Library/Developer/Xcode/DerivedData", home),
            "homebrew_cache" => format!("{}/Library/Caches/Homebrew", home),
            _ => continue,
        };
        let path = Path::new(&path_str);
        if path.exists() {
            if let Ok(freed) = clean_dir_contents(path) {
                bytes_freed += freed;
            }
        }
    }
    bytes_freed
}

#[tauri::command]
fn scan_large_files(min_size_mb: u64) -> Vec<LargeFileInfo> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return vec![];
    }

    let min_size_bytes = min_size_mb * 1024 * 1024;
    let home_path = Path::new(&home);
    let mut files = Vec::new();
    
    let scan_folders = vec!["Documents", "Downloads", "Desktop"];
    for folder in scan_folders {
        let path = home_path.join(folder);
        if path.exists() {
            find_large_files_rec(&path, min_size_bytes, &mut files, 0);
        }
    }

    files.sort_by(|a, b| b.size.cmp(&a.size));
    files
}

#[tauri::command]
fn delete_file(path_str: String) -> bool {
    let path = Path::new(&path_str);
    if path.exists() && path.is_file() {
        fs::remove_file(path).is_ok()
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_system_stats,
            get_processes,
            kill_process,
            scan_garbage_folders,
            clean_garbage,
            scan_large_files,
            delete_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
