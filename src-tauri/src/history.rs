//! Claude Code's saved sessions for a folder, which the new-session menu offers to resume. Claude keeps each
//! session as a JSON-lines transcript in `~/.claude/projects/<slug>/<id>.jsonl`; nook reads only a file's
//! start, for its first prompt, and its end, for a title the session was given.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const HEAD: u64 = 256 << 10; // where a transcript's first prompt is looked for
const TAIL: u64 = 64 << 10; // where its newest title is
const MOST: usize = 40; // the most sessions the menu lists
const PROMPT_CHARS: usize = 160;

#[derive(Serialize, Debug, PartialEq)]
pub struct Saved {
    id: String,
    /// When the session last changed, in ms since the epoch.
    modified: u64,
    prompt: String,
    title: Option<String>,
}

/// Claude Code's folder for its own data: `CLAUDE_CONFIG_DIR`, or `.claude` in the home folder.
pub(crate) fn claude_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return dir.into();
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    Path::new(&home).join(".claude")
}

/// The name Claude Code gives a project's folder: its path with each character but a letter or digit as `-`.
fn slug(dir: &str) -> String {
    dir.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The text of a transcript line that is a prompt the user typed, if it is one.
fn prompt(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"] != "user" || v["isMeta"] == true || v["isSidechain"] == true {
        return None;
    }
    let content = &v["message"]["content"];
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().find(|p| p["type"] == "text")?["text"].as_str()?.to_string(),
        _ => return None,
    };
    let text = text.trim();
    // Claude writes slash commands, their output, and interruptions as tagged rows in the user's name.
    if text.is_empty() || text.starts_with('<') || text.starts_with("[Request interrupted") {
        return None;
    }
    let first = text.lines().next().unwrap_or_default();
    Some(first.chars().take(PROMPT_CHARS).collect())
}

/// The newest title in a transcript's last lines: one set with /rename, or Claude's own summary.
fn title(tail: &str) -> Option<String> {
    tail.lines().rev().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        match v["type"].as_str()? {
            "custom-title" => v["customTitle"].as_str().map(str::to_string),
            "summary" => v["summary"].as_str().map(str::to_string),
            _ => None,
        }
    })
}

fn read_range(file: &mut File, from: u64, len: u64) -> String {
    let mut buf = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_ok() {
        let _ = file.take(len).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn saved(path: &Path, modified: u64) -> Option<Saved> {
    let id = path.file_stem()?.to_str()?.to_string();
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let prompt = read_range(&mut file, 0, HEAD).lines().find_map(prompt)?; // a session never prompted isn't listed
    let title = title(&read_range(&mut file, size.saturating_sub(TAIL), TAIL));
    Some(Saved { id, modified, prompt, title })
}

/// The sessions Claude Code saved for `dir`, newest first.
#[tauri::command(async)]
pub fn claude_sessions(dir: String) -> Vec<Saved> {
    let Ok(entries) = fs::read_dir(claude_dir().join("projects").join(slug(&dir))) else { return Vec::new() };
    let mut files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| {
            let at = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((e.path(), at))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.iter().filter_map(|(path, at)| saved(path, *at)).take(MOST).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_a_folder_as_claude_does() {
        assert_eq!(slug("/home/me/my_app.v2"), "-home-me-my-app-v2");
        assert_eq!(slug(r"C:\Users\me\nook"), "C--Users-me-nook");
    }

    #[test]
    fn finds_the_first_prompt_the_user_typed() {
        let lines = [
            r#"{"type":"queue-operation","operation":"enqueue"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: local commands"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"  Fix the tab strip\nand more"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"later"}}"#,
        ];
        assert_eq!(lines.iter().find_map(|l| prompt(l)), Some("Fix the tab strip".into()));
        assert_eq!(prompt("not json"), None);
    }

    #[test]
    fn takes_the_newest_title() {
        let tail = [
            r#"{"type":"summary","summary":"Tab strip work"}"#,
            r#"{"type":"assistant","message":{}}"#,
            r#"{"type":"custom-title","customTitle":"tabs"}"#,
            r#"{"type":"user","message":{"content":"x"}}"#,
        ]
        .join("\n");
        assert_eq!(title(&tail), Some("tabs".into()));
        assert_eq!(title(""), None);
    }

    #[test]
    fn lists_a_folders_sessions_newest_first() {
        let root = std::env::temp_dir().join(format!("nook-history-{}", std::process::id()));
        let dir = root.join("projects").join(slug("/work/app"));
        fs::create_dir_all(&dir).unwrap();
        let user = |text: &str| format!(r#"{{"type":"user","message":{{"content":"{text}"}}}}"#);
        fs::write(dir.join("old.jsonl"), user("first")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("new.jsonl"), user("second")).unwrap();
        fs::write(dir.join("empty.jsonl"), r#"{"type":"summary","summary":"x"}"#).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let ids: Vec<String> = claude_sessions("/work/app".into()).into_iter().map(|s| s.id).collect();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(ids, ["new", "old"]);
    }
}
