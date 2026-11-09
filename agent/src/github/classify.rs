//! Maps changed files to languages, using the names GitHub Linguist uses, and reads labels
//! from commit messages. Messages themselves are never kept.

use std::sync::LazyLock;

use regex::Regex;

pub const DOCS_DATA: &str = "Docs & data";
pub const SKIPPED: &str = "Skipped";

fn language_for_extension(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" | "pyi" => "Python",
        "pyx" => "Cython",
        "ipynb" => "Jupyter Notebook",
        "go" => "Go",
        "rs" => "Rust",
        "c" | "h" => "C",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "C++",
        "cs" => "C#",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "scala" => "Scala",
        "groovy" => "Groovy",
        "gradle" => "Gradle",
        "swift" => "Swift",
        "m" => "Objective-C",
        "mm" => "Objective-C++",
        "dart" => "Dart",
        "rb" => "Ruby",
        "php" => "PHP",
        "lua" => "Lua",
        "pl" | "pm" => "Perl",
        "r" => "R",
        "jl" => "Julia",
        "ex" | "exs" => "Elixir",
        "erl" | "hrl" => "Erlang",
        "clj" | "cljs" => "Clojure",
        "hs" => "Haskell",
        "ml" | "mli" => "OCaml",
        "fs" | "fsx" => "F#",
        "elm" => "Elm",
        "zig" => "Zig",
        "nim" => "Nim",
        "v" => "Verilog",
        "sv" => "SystemVerilog",
        "vhd" | "vhdl" => "VHDL",
        "sol" => "Solidity",
        "move" => "Move",
        "cairo" => "Cairo",
        "wgsl" => "WGSL",
        "glsl" => "GLSL",
        "hlsl" => "HLSL",
        "metal" => "Metal",
        "sh" | "bash" | "zsh" => "Shell",
        "fish" => "Fish",
        "ps1" => "PowerShell",
        "bat" | "cmd" => "Batchfile",
        "html" | "htm" => "HTML",
        "css" => "CSS",
        "scss" => "SCSS",
        "sass" => "Sass",
        "less" => "Less",
        "styl" => "Stylus",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "astro" => "Astro",
        "ejs" => "EJS",
        "hbs" => "Handlebars",
        "pug" => "Pug",
        "jinja" | "j2" => "Jinja",
        "sql" => "SQL",
        "graphql" | "gql" => "GraphQL",
        "proto" => "Protocol Buffer",
        "prisma" => "Prisma",
        "tf" | "hcl" => "HCL",
        "nix" => "Nix",
        "cmake" => "CMake",
        "mk" => "Makefile",
        "vim" => "Vim Script",
        "tex" => "TeX",
        "asm" | "s" => "Assembly",
        "mdc" => "Markdown",
        _ => return None,
    })
}

const DOCS_AND_DATA: &[&str] = &[
    "md", "mdx", "markdown", "rst", "adoc", "txt", "json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
    "csv", "tsv", "xml", "svg", "plist", "properties", "lock", "log",
];

const VENDORED: &[&str] = &[
    "node_modules", "vendor", "vendors", "third_party", "thirdparty", "bower_components", "site-packages", ".venv", "venv", "pods", "carthage", ".yarn",
    ".pnp", "jspm_packages", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", ".turbo", ".output", ".cache", "__pycache__", "coverage",
    "generated", "__generated__", "__snapshots__", "storybook-static",
];

const GENERATED_FILES: &[&str] = &[
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "cargo.lock", "poetry.lock", "uv.lock",
    "pipfile.lock", "gemfile.lock", "composer.lock", "go.sum", "flake.lock", "podfile.lock", "pubspec.lock", "mix.lock",
];

static GENERATED_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\.min\.(js|css)|\.bundle\.js|\.map|\.snap|\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.g\.dart|\.freezed\.dart|\.generated\.\w+|\.gen\.\w+|\.d\.ts)$").unwrap()
});

/// The language a file counts toward: DOCS_DATA for prose and config, SKIPPED for
/// vendored or generated output and binary or unknown types.
pub fn classify_path(path: &str) -> String {
    let mut segments: Vec<&str> = path.split('/').collect();
    let name = segments.pop().unwrap_or("").to_lowercase();

    if segments.iter().any(|segment| VENDORED.contains(&segment.to_lowercase().as_str())) {
        return SKIPPED.into();
    }
    if GENERATED_FILES.contains(&name.as_str()) || GENERATED_PATTERN.is_match(&name) {
        return SKIPPED.into();
    }
    let by_name = match name.as_str() {
        "dockerfile" | "containerfile" => Some("Dockerfile"),
        "makefile" => Some("Makefile"),
        "justfile" => Some("Just"),
        "cmakelists.txt" => Some("CMake"),
        "rakefile" | "gemfile" | "vagrantfile" | "brewfile" => Some("Ruby"),
        _ => None,
    };
    if let Some(language) = by_name {
        return language.into();
    }
    if name.starts_with("dockerfile.") {
        return "Dockerfile".into();
    }
    let Some(dot) = name.rfind('.').filter(|dot| *dot > 0) else {
        return if name.starts_with('.') { DOCS_DATA.into() } else { SKIPPED.into() };
    };
    let extension = &name[dot + 1..];
    if DOCS_AND_DATA.contains(&extension) {
        return DOCS_DATA.into();
    }
    language_for_extension(extension).unwrap_or(SKIPPED).into()
}

/// Languages GitHub may report on gist files that are not really code.
pub fn is_code_language(name: &str) -> bool {
    const NON_CODE: &[&str] = &[
        "text", "markdown", "json", "json with comments", "json5", "yaml", "toml", "csv", "tsv", "xml", "svg", "ini", "restructuredtext", "asciidoc", "diff",
        "ignore list", "git config", "git attributes", "public key", "unknown", "plain text", "robots.txt", "editorconfig", "dotenv",
    ];
    !NON_CODE.contains(&name.to_lowercase().as_str())
}

static COMMIT_KIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^([a-z]+)(\([^)]*\))?!?:").unwrap());

pub fn commit_kind(headline: &str) -> Option<String> {
    const KINDS: &[&str] = &["feat", "fix", "chore", "refactor", "docs", "test", "perf", "style", "build", "ci", "revert"];
    let kind = COMMIT_KIND.captures(headline)?.get(1)?.as_str().to_lowercase();
    KINDS.contains(&kind.as_str()).then_some(kind)
}

macro_rules! regex {
    ($pattern:literal) => {{
        static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
        &*PATTERN
    }};
}

/// Identifies an AI assistant from a co-author identity. Claude and Devin are also people's
/// names, so a name alone only counts with a product word beside it; otherwise the email
/// domain or account has to match.
pub fn ai_coauthor(name: &str, email: &str, login: Option<&str>) -> Option<&'static str> {
    let mail = email.to_lowercase();
    let account = login.unwrap_or("").to_lowercase();
    let person = name.trim();
    let joined = format!("{mail} {account}");

    if mail.ends_with("@anthropic.com") || account == "claude" || regex!(r"(?i)^claude (code|opus|sonnet|haiku|fable)\b").is_match(person) {
        return Some("Claude");
    }
    if mail.ends_with("@openai.com") || account == "codex" || regex!(r"(?i)^(chatgpt|codex|openai codex)\b").is_match(person) {
        return Some("Codex");
    }
    if mail.contains("copilot") || account == "copilot" || regex!(r"(?i)^(github )?copilot\b").is_match(person) {
        return Some("Copilot");
    }
    if regex!(r"@cursor\.(com|sh)$").is_match(&mail) || regex!(r"(?i)^cursor( ?agent)?$").is_match(person) {
        return Some("Cursor");
    }
    if regex!(r"(?i)^gemini\b").is_match(person) || joined.contains("gemini-code-assist") || joined.contains("google-labs-jules") {
        return Some("Gemini");
    }
    if regex!(r"(?i)^aider\b").is_match(person) || mail.starts_with("aider@") {
        return Some("Aider");
    }
    if format!("{joined} {}", person.to_lowercase()).contains("devin-ai-integration") {
        return Some("Devin");
    }
    if regex!(r"(?i)^(windsurf|cascade)\b").is_match(person) || regex!(r"@(codeium|windsurf)\.com$").is_match(&mail) {
        return Some("Windsurf");
    }
    None
}

/// Reads AI credit from `Co-authored-by` trailers and "Generated with" footers only, not prose.
pub fn ai_agent(message: &str) -> Option<String> {
    let trailer = regex!(r"(?i)^\s*co-authored-by:\s*(.*?)\s*<([^>]*)>");
    let generated = regex!(r"(?i)generated (with|by)\b");
    for line in message.lines() {
        if let Some(captures) = trailer.captures(line) {
            if let Some(agent) = ai_coauthor(&captures[1], &captures[2], None) {
                return Some(agent.to_string());
            }
            continue;
        }
        if !generated.is_match(line) {
            continue;
        }
        let lower = line.to_lowercase();
        let found = [
            ("claude", "Claude"),
            ("codex", "Codex"),
            ("chatgpt", "Codex"),
            ("openai", "Codex"),
            ("copilot", "Copilot"),
            ("cursor", "Cursor"),
            ("gemini", "Gemini"),
            ("aider", "Aider"),
            ("devin", "Devin"),
            ("windsurf", "Windsurf"),
            ("codeium", "Windsurf"),
        ]
        .iter()
        .find(|(word, _)| lower.contains(word));
        if let Some((_, agent)) = found {
            return Some((*agent).to_string());
        }
    }
    None
}

/// "Claude Opus 5 (1M context)" -> "Claude Opus 5", so a model keeps one row.
pub fn ai_label(name: &str, family: &str) -> String {
    let clean = regex!(r"\s*\([^)]*\)\s*$").replace(name, "");
    let clean = clean.trim();
    if clean.to_lowercase().starts_with(&family.to_lowercase()) && clean.chars().count() <= 24 { clean.to_string() } else { family.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_files_map_to_linguist_names() {
        for (path, language) in [
            ("src/app.tsx", "TypeScript"),
            ("lib/util.py", "Python"),
            ("native/main.rs", "Rust"),
            ("notebooks/eda.ipynb", "Jupyter Notebook"),
            ("Dockerfile", "Dockerfile"),
            ("docker/Dockerfile.prod", "Dockerfile"),
            ("Makefile", "Makefile"),
        ] {
            assert_eq!(classify_path(path), language, "{path}");
        }
    }

    #[test]
    fn prose_and_config_count_as_docs() {
        for path in ["README.md", "config/settings.yaml", "package.json", ".gitignore"] {
            assert_eq!(classify_path(path), DOCS_DATA, "{path}");
        }
    }

    #[test]
    fn generated_vendored_and_binary_files_are_skipped() {
        for path in [
            "node_modules/react/index.js", "vendor/lib/thing.go", "dist/bundle.js", "web/.next/server/app.js", "pnpm-lock.yaml", "Cargo.lock", "go.sum",
            "public/app.min.js", "types/index.d.ts", "api/service.pb.go", "assets/logo.png", "LICENSE",
        ] {
            assert_eq!(classify_path(path), SKIPPED, "{path}");
        }
    }

    #[test]
    fn ai_coauthors_match_product_identities() {
        assert_eq!(ai_coauthor("Claude Opus 5.5", "noreply@anthropic.com", None), Some("Claude"));
        assert_eq!(ai_coauthor("Claude", "noreply@anthropic.com", None), Some("Claude"));
        assert_eq!(ai_coauthor("Claude Code", "", None), Some("Claude"));
        assert_eq!(ai_coauthor("Copilot", "175728472+Copilot@users.noreply.github.com", None), Some("Copilot"));
        assert_eq!(ai_coauthor("Cursor Agent", "cursoragent@cursor.com", None), Some("Cursor"));
        assert_eq!(ai_coauthor("Codex", "codex@openai.com", None), Some("Codex"));
    }

    #[test]
    fn people_who_share_a_name_with_a_product_stay_people() {
        assert_eq!(ai_coauthor("Claude Dupont", "claude@dupont.fr", None), None);
        assert_eq!(ai_coauthor("Claude", "claude@example.com", None), None);
        assert_eq!(ai_coauthor("Devin Smith", "devin@example.com", None), None);
        assert_eq!(ai_coauthor("Jules Verne", "jules@example.com", None), None);
    }

    #[test]
    fn ai_credit_reads_trailers_and_footers_not_prose() {
        assert_eq!(ai_agent("fix: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>").as_deref(), Some("Claude"));
        assert_eq!(ai_agent("feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)").as_deref(), Some("Claude"));
        assert_eq!(ai_agent("docs: compare Claude and Copilot pricing"), None);
        assert_eq!(ai_agent("fix: x\n\nCo-authored-by: Claude Dupont <claude@dupont.fr>"), None);
    }

    #[test]
    fn labels_keep_one_row_per_model() {
        assert_eq!(ai_label("Claude Opus 5 (1M context)", "Claude"), "Claude Opus 5");
        assert_eq!(ai_label("Claude", "Claude"), "Claude");
        assert_eq!(ai_label("GitHub Copilot", "Copilot"), "Copilot");
    }

    #[test]
    fn conventional_commit_types_are_recognized() {
        assert_eq!(commit_kind("feat(api): add route").as_deref(), Some("feat"));
        assert_eq!(commit_kind("fix!: breaking").as_deref(), Some("fix"));
        assert_eq!(commit_kind("Update readme"), None);
        assert_eq!(commit_kind("note: not a known type"), None);
    }

    #[test]
    fn gist_languages_exclude_prose_and_data() {
        assert!(is_code_language("TypeScript"));
        assert!(!is_code_language("Markdown"));
        assert!(!is_code_language("JSON"));
    }
}
