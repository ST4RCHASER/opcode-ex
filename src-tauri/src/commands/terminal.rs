use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

/// Holds all active terminal sessions
pub struct TerminalState {
    pub sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Spawn a new PTY terminal session
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    terminal_id: String,
    cwd: String,
) -> Result<String, String> {
    log::info!("Spawning terminal {} in {}", terminal_id, cwd);

    let pty_system = native_pty_system();

    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Determine shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell to source profile
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    // Inherit essential env vars
    let home = std::env::var("HOME").unwrap_or_default();
    cmd.env("HOME", &home);
    if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", &user);
    }
    if let Ok(path) = std::env::var("PATH") {
        // Build comprehensive PATH like claude_binary.rs does
        let extra_paths = [
            format!("{home}/.local/bin"),
            format!("{home}/.cargo/bin"),
            format!("{home}/.bun/bin"),
            "/opt/homebrew/bin".to_string(),
            "/opt/homebrew/sbin".to_string(),
            "/usr/local/bin".to_string(),
            "/usr/local/sbin".to_string(),
            "/usr/bin".to_string(),
            "/usr/sbin".to_string(),
            "/bin".to_string(),
            "/sbin".to_string(),
        ];
        let shell_path = std::process::Command::new("/bin/bash")
            .args(["-l", "-c", "echo $PATH"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let mut seen = std::collections::HashSet::new();
        let mut parts: Vec<String> = Vec::new();
        for p in shell_path
            .split(':')
            .chain(extra_paths.iter().map(|s| s.as_str()))
            .chain(path.split(':'))
        {
            if !p.is_empty() && seen.insert(p.to_string()) {
                parts.push(p.to_string());
            }
        }
        cmd.env("PATH", parts.join(":"));
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Store session
    let state = app.state::<TerminalState>();
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                writer,
                _child: child,
                master: pair.master,
            },
        );
    }

    // Spawn reader task that emits output to frontend
    let tid = terminal_id.clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // PTY closed
                    let _ = app_clone.emit(&format!("terminal-exit:{}", tid), true);
                    break;
                }
                Ok(n) => {
                    // Send raw bytes as base64 to frontend
                    use base64::Engine;
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ =
                        app_clone.emit(&format!("terminal-output:{}", tid), &encoded);
                }
                Err(e) => {
                    log::error!("PTY read error: {}", e);
                    let _ = app_clone.emit(&format!("terminal-exit:{}", tid), false);
                    break;
                }
            }
        }
    });

    Ok(terminal_id)
}

/// Write data to a terminal session (from xterm.js keystrokes)
#[tauri::command]
pub async fn terminal_write(
    app: AppHandle,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&terminal_id) {
        session
            .writer
            .write_all(&bytes)
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;
    } else {
        return Err("Terminal session not found".to_string());
    }
    Ok(())
}

/// Resize a terminal session
#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&terminal_id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;
    }
    Ok(())
}

/// Kill a terminal session
#[tauri::command]
pub async fn terminal_kill(app: AppHandle, terminal_id: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().await;
    if sessions.remove(&terminal_id).is_some() {
        log::info!("Killed terminal session: {}", terminal_id);
    }
    Ok(())
}
