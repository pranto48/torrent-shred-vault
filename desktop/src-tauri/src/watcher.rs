use crate::{is_suppressed, log_activity, perform_sync_cycle, queue_path_event, run_peer_listener, runtime_config_for_watch, AppState};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    path::PathBuf,
    sync::mpsc,
    thread,
    time::Duration,
};

pub fn start_background_services(state: AppState) {
    let watcher_state = state.clone();
    thread::spawn(move || run_file_watcher(watcher_state));

    let peer_state = state.clone();
    thread::spawn(move || run_peer_listener(peer_state));

    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(20));
        if runtime_config_for_watch(&state).map(|config| config.sync_enabled).unwrap_or(false) {
            if let Err(error) = perform_sync_cycle(&state) {
                let _ = log_activity(&state, "error", &format!("Background sync failed: {error}"));
            }
        }
    });
}

fn run_file_watcher(state: AppState) {
    let (tx, rx) = mpsc::channel();
    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(watcher) => watcher,
        Err(error) => {
            let _ = log_activity(&state, "error", &format!("Failed to start file watcher: {error}"));
            return;
        }
    };

    let mut watched: Vec<PathBuf> = Vec::new();
    loop {
        if let Some(config) = runtime_config_for_watch(&state) {
            let desired = vec![config.user_root.clone(), config.share_root.clone()];
            if desired != watched {
                for root in &watched {
                    let _ = watcher.unwatch(root);
                }
                watched.clear();
                for root in desired {
                    if root.exists() && watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
                        watched.push(root);
                    }
                }
            }
        }

        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(event)) => handle_event(&state, event),
            Ok(Err(error)) => {
                let _ = log_activity(&state, "error", &format!("File watcher error: {error}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn handle_event(state: &AppState, event: Event) {
    for path in event.paths {
        if is_suppressed(state, &path) {
            continue;
        }
        if queue_path_event(state, &path).is_err() {
            let _ = log_activity(
                state,
                "warn",
                &format!("Skipped watcher event for {}", path.to_string_lossy()),
            );
        }
    }
}
