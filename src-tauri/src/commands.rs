//! The slash commands and skills Claude Code offers in a folder, for the quick-prompts picker: the person's
//! own, in `~/.claude`, and a project's, in `.claude` in the folder or any folder above it up to its git root.
//! nook reads only each file's frontmatter, for a description.
use crate::history::claude_dir;
use crate::json::object;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const HEAD: u64 = 4 << 10; // where a command's frontmatter is
const MOST: usize = 200;
const DESCRIPTION_CHARS: usize = 120;

#[derive(Debug, PartialEq)]
pub struct Command {
    /// What follows the slash: `review`, or `frontend:test` for commands/frontend/test.md.
    name: String,
    description: String,
}

object!(Command { name, description });

/// A frontmatter field's value, or the first line of prose when `field` is absent.
fn describe(head: &str, field: &str) -> Option<String> {
    let mut lines = head.lines();
    let mut found = None;
    if head.starts_with("---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
            if let Some(v) = line.strip_prefix(field).and_then(|r| r.trim_start().strip_prefix(':')) {
                found = Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
            }
        }
    }
    let text = found.filter(|v| !v.is_empty()).or_else(|| {
        lines.map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches('#').trim().to_string())
    })?;
    Some(text.chars().take(DESCRIPTION_CHARS).collect())
}

fn head(path: &Path) -> String {
    let mut buf = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(HEAD).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// `dir`'s commands, `*.md` at any depth, a folder's name joined to its file's with `:`.
fn commands_in(dir: &Path, prefix: &str, out: &mut Vec<Command>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let (path, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        if path.is_dir() {
            commands_in(&path, &format!("{prefix}{name}:"), out);
        } else if let Some(stem) = name.strip_suffix(".md") {
            out.push(Command { name: format!("{prefix}{stem}"), description: describe(&head(&path), "description").unwrap_or_default() });
        }
    }
}

/// `dir`'s skills, each a folder holding a SKILL.md, named by its frontmatter or its folder.
fn skills_in(dir: &Path, out: &mut Vec<Command>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let text = head(&e.path().join("SKILL.md"));
        if text.is_empty() {
            continue;
        }
        let name = describe(&text, "name").filter(|_| text.starts_with("---")).unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
        out.push(Command { name, description: describe(&text, "description").unwrap_or_default() });
    }
}

/// The `.claude` folders that apply in `dir`: its own and its parents' up to its git root, then the person's.
fn claude_folders(dir: &Path) -> Vec<PathBuf> {
    let mut folders = Vec::new();
    for d in dir.ancestors() {
        folders.push(d.join(".claude"));
        if d.join(".git").exists() {
            break;
        }
    }
    folders.push(claude_dir());
    folders
}

fn list(dir: &Path) -> Vec<Command> {
    let mut all = Vec::new();
    for folder in claude_folders(dir) {
        commands_in(&folder.join("commands"), "", &mut all);
        skills_in(&folder.join("skills"), &mut all);
    }
    // The nearer folder's command wins a name.
    let mut seen = std::collections::HashSet::new();
    all.retain(|c| seen.insert(c.name.clone()));
    all.sort_by(|a, b| a.name.cmp(&b.name));
    all.truncate(MOST);
    all
}

/// The slash commands and skills Claude Code offers a session in `dir`.
pub fn claude_commands(dir: String) -> Vec<Command> {
    list(Path::new(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_from_frontmatter_or_the_first_line() {
        assert_eq!(describe("---\ndescription: \"Review a PR\"\n---\nBody", "description"), Some("Review a PR".into()));
        assert_eq!(describe("---\nallowed-tools: Bash\n---\n\n# Ship it\nmore", "description"), Some("Ship it".into()));
        assert_eq!(describe("Fix the build\n", "description"), Some("Fix the build".into()));
        assert_eq!(describe("", "description"), None);
    }

    #[test]
    fn lists_a_projects_commands_and_skills_nearest_first() {
        let root = std::env::temp_dir().join(format!("nook-commands-{}", std::process::id()));
        let repo = root.join("repo");
        let sub = repo.join("app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".claude/commands/frontend")).unwrap();
        fs::create_dir_all(sub.join(".claude/commands")).unwrap();
        fs::create_dir_all(repo.join(".claude/skills/deploy")).unwrap();
        fs::create_dir_all(root.join(".claude/commands")).unwrap(); // above the git root: not this project's
        fs::write(repo.join(".claude/commands/review.md"), "---\ndescription: Repo review\n---\n").unwrap();
        fs::write(sub.join(".claude/commands/review.md"), "---\ndescription: App review\n---\n").unwrap();
        fs::write(repo.join(".claude/commands/frontend/test.md"), "Run the UI tests").unwrap();
        fs::write(repo.join(".claude/skills/deploy/SKILL.md"), "---\nname: ship\ndescription: Deploy it\n---\n").unwrap();
        fs::write(root.join(".claude/commands/outside.md"), "x").unwrap();
        let mine = root.join("home");
        fs::create_dir_all(mine.join("commands")).unwrap();
        fs::write(mine.join("commands/standup.md"), "Write my standup").unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &mine);
        let got = list(&sub);
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        fs::remove_dir_all(&root).unwrap();
        let pairs: Vec<(&str, &str)> = got.iter().map(|c| (c.name.as_str(), c.description.as_str())).collect();
        assert_eq!(pairs, [("frontend:test", "Run the UI tests"), ("review", "App review"), ("ship", "Deploy it"), ("standup", "Write my standup")]);
    }
}
