//! Keeps typing responsive while the CPU is saturated (say, by data-loader workers): nook, its
//! WebView2 processes, the console host, the shell, and Claude run above normal priority.
//! What Claude launches stays normal: the walk stops at claude.exe, and Windows never passes
//! above-normal priority on to child processes.
use crate::sys::*;
use std::{collections::HashSet, path::Path, thread, time::Duration};

const TYPING_PATH: [&str; 3] = ["msedgewebview2.exe", "conhost.exe", "claude.exe"];

struct Process {
    pid: u32,
    parent: u32,
    exe: String,
}

/// Re-applied every 2s: Claude and WebView2 processes come and go.
pub fn keep_typing_path_elevated(shell: &str) {
    let shell = Path::new(shell).file_stem().map_or(String::new(), |s| format!("{}.exe", s.to_string_lossy().to_lowercase()));
    thread::spawn(move || loop {
        let root = unsafe { GetCurrentProcessId() };
        for pid in typing_path(&processes(), root, &shell) {
            elevate(pid);
        }
        thread::sleep(Duration::from_secs(2));
    });
}

/// `root` and its descendants on the typing path, not descending past claude.exe.
fn typing_path(all: &[Process], root: u32, shell: &str) -> Vec<u32> {
    let mut picked = vec![root];
    let mut seen = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        for p in all.iter().filter(|p| p.parent == parent && seen.insert(p.pid)) {
            let exe = p.exe.to_lowercase();
            if !TYPING_PATH.contains(&exe.as_str()) && exe != shell {
                continue;
            }
            picked.push(p.pid);
            if exe != "claude.exe" {
                stack.push(p.pid);
            }
        }
    }
    picked
}

fn processes() -> Vec<Process> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut e) != 0;
        while more {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let exe = String::from_utf16_lossy(&e.szExeFile[..len]);
            out.push(Process { pid: e.th32ProcessID, parent: e.th32ParentProcessID, exe });
            more = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

fn elevate(pid: u32) {
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if !h.is_null() {
            SetPriorityClass(h, ABOVE_NORMAL_PRIORITY_CLASS);
            CloseHandle(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, exe: &str) -> Process {
        Process { pid, parent, exe: exe.into() }
    }

    #[test]
    fn elevates_the_typing_path_but_nothing_claude_or_the_shell_launches() {
        let all = [
            p(1, 0, "nook.exe"),
            p(2, 1, "msedgewebview2.exe"),
            p(3, 2, "msedgewebview2.exe"),
            p(4, 1, "conhost.exe"),
            p(5, 1, "pwsh.exe"),
            p(6, 5, "claude.exe"),
            p(7, 6, "bash.exe"),      // a tool Claude runs
            p(8, 7, "python.exe"),    // ...and what that tool runs
            p(9, 5, "python.exe"),    // typed straight into the shell
            p(10, 99, "claude.exe"),  // another app's Claude
        ];
        let mut picked = typing_path(&all, 1, "pwsh.exe");
        picked.sort();
        assert_eq!(picked, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn survives_a_parent_cycle_from_pid_reuse() {
        let all = [p(1, 0, "nook.exe"), p(2, 1, "conhost.exe"), p(1, 2, "conhost.exe")];
        assert_eq!(typing_path(&all, 1, "pwsh.exe"), [1, 2]);
    }
}
