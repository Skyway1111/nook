//! What settings.json holds, its defaults, and its JSON: read over the defaults, and written in field order.
use crate::json::{self, obj, Error, Out, Reader, Take, W};
use std::path::Path;

/// Declares `Settings` with each field's key in settings.json, where the fields keep this order, and the
/// reader that sets each field.
macro_rules! settings {
    ($($(#[$doc:meta])* $field:ident $key:literal: $t:ty,)*) => {
        pub struct Settings {
            $($(#[$doc])* pub $field: $t,)*
        }

        impl W for Settings {
            fn w(&self, o: &mut Out) {
                json::Obj(&[$(($key, &self.$field as &dyn W)),*]).w(o);
            }
        }

        impl Settings {
            const KEYS: &[&str] = &[$($key),*];
            /// For each key, in `KEYS`' order, what reads the value ahead into its field.
            const SET: &[fn(&mut Settings, &mut Reader) -> Result<(), Error>] = &[$(|s, p| Take::take(p).map(|v| s.$field = v)),*];
        }

        const _: () = assert!(Settings::KEYS.len() <= 64, "`known` keeps one bit per key");
    };
}

settings! {
    /// What each Claude tab runs in its terminal.
    command "command": Vec<String>,
    /// Off: the UI renders on the CPU, so a saturated GPU can't delay typing.
    gpu "gpu": bool,
    pinned "pinned": Vec<String>,
    last_dir "lastDir": String,
    /// The file browser's and git panel's dragged widths. None: the theme's `--sidebar-width`.
    files_width "filesWidth": Option<u32>,
    git_width "gitWidth": Option<u32>,
    /// The installed theme in use, a folder in `themes`. None: nook's defaults.
    theme "theme": Option<String>,
    /// Whether picking a theme also sets Claude's own theme to nook's.
    claude_follows "claudeFollows": bool,
    /// Claude's theme before nook set it, for when Claude stops following.
    claude_theme "claudeTheme": Option<String>,
    /// Whether the theme follows the system's light and dark: `day_theme` while it's light, `night_theme`
    /// while it's dark. Each is a folder in `themes`, "" for nook's defaults, or None until one is picked.
    light_dark "lightDark": bool,
    day_theme "dayTheme": Option<String>,
    night_theme "nightTheme": Option<String>,
    /// Quick prompts, which Ctrl+Shift+P pastes into Claude's prompt. `{file}` is the file open last,
    /// `{folder}` the file browser's folder.
    prompts "prompts": Vec<Prompt>,
    /// Whether nook reopens the Claude sessions that were open when it closed.
    reopen_sessions "reopenSessions": bool,
    /// Whether a Claude session that needs the user or finishes while nook's window is in the background
    /// shows a desktop notification.
    notifications "notifications": bool,
    /// The Claude sessions open now, in tab order, for the next start to resume.
    sessions "sessions": Vec<OpenSession>,
}

#[derive(Debug, PartialEq)]
pub struct OpenSession {
    /// Where the tab started Claude.
    pub dir: String,
    /// Claude Code's session id, for `claude --resume`.
    pub id: String,
    /// Its first prompt, for the tab's tooltip until it starts.
    pub prompt: String,
    /// Whether its tab was the one showing.
    pub active: bool,
}

#[derive(Debug, PartialEq)]
pub struct Prompt {
    pub name: String,
    pub text: String,
}

/// The quick prompts nook starts with.
const PROMPTS: [(&str, &str); 6] = [
    ("Review my changes", "Review my uncommitted changes for bugs, and for anything I'd regret shipping."),
    ("Explain this file", "Explain {file}: what it does, how it fits in, and anything surprising."),
    ("Write tests", "Write tests for {file} that cover its edge cases, then run them."),
    ("Fix the failing tests", "Run the tests, find why the failing ones fail, and fix the cause rather than the test."),
    ("Plan first", "Before changing anything, write a short plan and wait for my go-ahead: "),
    ("Commit", "Commit the staged changes with a message that says why, not just what."),
];

/// What a Claude tab runs until settings.json says otherwise: Claude, then the shell it ran in.
#[cfg(windows)]
const DEFAULT_COMMAND: [&str; 5] = ["powershell", "-NoLogo", "-NoExit", "-Command", "claude"];
#[cfg(not(windows))]
const DEFAULT_COMMAND: [&str; 3] = ["bash", "-lc", "claude; exec bash -l"];

impl Default for Settings {
    fn default() -> Self {
        let home = crate::home_dir();
        let under = |d: &str| Path::new(&home).join(d).to_string_lossy().into_owned();
        Self {
            command: DEFAULT_COMMAND.map(String::from).into(),
            gpu: false,
            pinned: vec![under("Desktop"), under("Downloads"), under("Documents"), home.clone()],
            last_dir: home,
            files_width: None,
            git_width: None,
            theme: None,
            claude_follows: true,
            claude_theme: None,
            light_dark: false,
            day_theme: None,
            night_theme: None,
            reopen_sessions: true,
            notifications: true,
            sessions: Vec::new(),
            prompts: PROMPTS.iter().map(|(name, text)| Prompt { name: name.to_string(), text: text.to_string() }).collect(),
        }
    }
}

impl Settings {
    /// settings.json's `text`, read over the defaults. Keys it doesn't hold are ignored.
    pub fn parse(text: &str) -> Result<Settings, String> {
        let mut s = Settings::default();
        let mut p = Reader::new(text);
        p.known("struct Settings", Self::KEYS, |p, i| Self::SET[i](&mut s, p)).and_then(|()| p.end()).map_err(|e| e.to_string())?;
        Ok(s)
    }

    /// Sets the keys of `patch`, a JSON object. Fails, saying what but not where, on a value of the wrong type.
    pub fn merge(&mut self, patch: &str) -> Result<(), String> {
        let mut p = Reader::new(patch);
        p.known("struct Settings", Self::KEYS, |p, i| Self::SET[i](self, p)).and_then(|()| p.end()).map_err(|e| e.what().into())
    }
}

impl W for OpenSession {
    fn w(&self, o: &mut Out) {
        obj! { "dir": self.dir, "id": self.id, "prompt": self.prompt, "active": self.active }.w(o);
    }
}

impl W for Prompt {
    fn w(&self, o: &mut Out) {
        obj! { "name": self.name, "text": self.text }.w(o);
    }
}

impl Take for Prompt {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let mut v = [None, None];
        p.known("struct Prompt", &["name", "text"], |p, i| String::take(p).map(|s| v[i] = Some(s)))?;
        let [name, text] = v;
        Ok(Prompt { name: p.needs(name, "name")?, text: p.needs(text, "text")? })
    }
}

impl Take for OpenSession {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let (mut dir, mut id, mut prompt, mut active) = (None, None, String::new(), false);
        p.known("struct OpenSession", &["dir", "id", "prompt", "active"], |p, i| {
            match i {
                0 => dir = Some(String::take(p)?),
                1 => id = Some(String::take(p)?),
                2 => prompt = String::take(p)?,
                _ => active = bool::take(p)?,
            }
            Ok(())
        })?;
        Ok(OpenSession { dir: p.needs(dir, "dir")?, id: p.needs(id, "id")?, prompt, active })
    }
}

#[cfg(test)]
mod tests {
    use super::{OpenSession, Settings};

    fn merged(patch: &str) -> Result<Settings, String> {
        let mut s = Settings::default();
        s.merge(patch).map(|()| s)
    }

    #[test]
    fn merges_a_patch_and_refuses_a_wrong_type() {
        let s = merged(r#"{ "gpu": true, "gitWidth": 300 }"#).unwrap();
        assert!(s.gpu);
        assert_eq!((s.git_width, s.files_width), (Some(300), None));
        assert_eq!(merged(r#"{ "command": "claude" }"#).err().unwrap(), r#"invalid type: string "claude", expected a sequence"#);
    }

    #[test]
    fn keeps_the_open_sessions() {
        let s = merged(r#"{ "sessions": [{ "dir": "/work", "id": "abc", "active": true }] }"#).unwrap();
        assert_eq!(s.sessions, [OpenSession { dir: "/work".into(), id: "abc".into(), prompt: String::new(), active: true }]);
        assert!(s.reopen_sessions && s.notifications);
    }
}
