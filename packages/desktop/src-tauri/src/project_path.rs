use std::{fs, path::Path, process::Command};

const WINDOWS_INVALID_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathPlatform {
    Windows,
    #[allow(dead_code)]
    MacOS,
}

fn current_platform() -> PathPlatform {
    #[cfg(target_os = "windows")]
    {
        PathPlatform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        PathPlatform::MacOS
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        PathPlatform::MacOS
    }
}

fn validate_project_name_for(name: &str, platform: PathPlatform) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("project name is empty or reserved".into());
    }

    match platform {
        PathPlatform::Windows => {
            if name.ends_with(['.', ' ']) {
                return Err("project name cannot end with a dot or space".into());
            }
            if name.chars().any(|character| {
                character.is_control() || WINDOWS_INVALID_CHARACTERS.contains(&character)
            }) {
                return Err("project name contains an invalid Windows character".into());
            }

            let device_name = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
            let numbered_device = device_name
                .strip_prefix("COM")
                .or_else(|| device_name.strip_prefix("LPT"))
                .is_some_and(|suffix| {
                    matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                });
            if matches!(device_name.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
                return Err("project name is reserved by Windows".into());
            }
        }
        PathPlatform::MacOS => {
            if name
                .chars()
                .any(|character| character.is_control() || matches!(character, '/' | ':'))
            {
                return Err("project name contains an invalid macOS character".into());
            }
        }
    }

    Ok(name)
}

pub fn validate_project_name(name: &str) -> Result<&str, String> {
    validate_project_name_for(name, current_platform())
}

#[tauri::command]
pub fn create_project_directory(parent: String, name: String) -> Result<String, String> {
    let name = validate_project_name(&name)?;
    let parent = fs::canonicalize(Path::new(&parent))
        .map_err(|error| format!("selected parent directory is unavailable: {error}"))?;
    if !parent.is_dir() {
        return Err("selected parent path is not a directory".into());
    }

    let target = parent.join(name);
    if target
        .try_exists()
        .map_err(|error| format!("could not inspect project directory: {error}"))?
    {
        return Err("project directory already exists".into());
    }

    fs::create_dir(&target)
        .map_err(|error| format!("could not create project directory: {error}"))?;
    let result = fs::canonicalize(&target)
        .map_err(|error| format!("could not validate project directory: {error}"))?;
    if !result.starts_with(&parent) {
        return Err("created project directory escaped its selected parent".into());
    }
    result
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "created project directory is not valid UTF-8".into())
}

fn is_absolute_for(path: &str, platform: PathPlatform) -> bool {
    match platform {
        PathPlatform::Windows => {
            let bytes = path.as_bytes();
            (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/'))
                || path.starts_with(r"\\")
        }
        PathPlatform::MacOS => path.starts_with('/'),
    }
}

fn validate_global_config_file_for(path: &str, platform: PathPlatform) -> Result<&str, String> {
    let path_value = Path::new(path);
    if !is_absolute_for(path, platform) {
        return Err("global config path must be absolute".into());
    }
    let name = match platform {
        PathPlatform::Windows => path.rsplit(['\\', '/']).next(),
        PathPlatform::MacOS => path_value.file_name().and_then(|value| value.to_str()),
    };
    let Some(name) = name else {
        return Err("global config path has no valid filename".into());
    };
    if !matches!(name, "jyycode.jsonc" | "jyycode.json") {
        return Err("global config path must name jyycode.jsonc or jyycode.json".into());
    }
    Ok(path)
}

fn reveal_command_for(
    path: &str,
    platform: PathPlatform,
) -> Result<(&'static str, [String; 2]), String> {
    let path = validate_global_config_file_for(path, platform)?;
    match platform {
        PathPlatform::Windows => Ok(("explorer.exe", ["/select,".into(), path.into()])),
        PathPlatform::MacOS => Ok(("/usr/bin/open", ["-R".into(), path.into()])),
    }
}

#[tauri::command]
pub fn reveal_config_file(path: String) -> Result<(), String> {
    let (program, arguments) = reveal_command_for(&path, current_platform())?;
    Command::new(program)
        .args(arguments)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not reveal global config file: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        PathPlatform, create_project_directory, reveal_command_for,
        validate_global_config_file_for, validate_project_name_for,
    };

    #[test]
    fn rejects_unsafe_windows_project_names() {
        for name in [
            "", ".", "..", "a/b", "a\\b", "CON", "con.txt", "COM1", "lpt9.md", "name.", "name ",
            "a:b",
        ] {
            assert!(
                validate_project_name_for(name, PathPlatform::Windows).is_err(),
                "accepted {name}"
            );
        }
        assert_eq!(
            validate_project_name_for("my-project", PathPlatform::Windows).unwrap(),
            "my-project"
        );
    }

    #[test]
    fn applies_macos_project_name_rules() {
        for name in ["", ".", "..", "a/b", "a:b", "line\nbreak"] {
            assert!(
                validate_project_name_for(name, PathPlatform::MacOS).is_err(),
                "accepted {name:?}"
            );
        }
        for name in ["my-project", r"a\b", "CON", "name.", "name "] {
            assert_eq!(
                validate_project_name_for(name, PathPlatform::MacOS).unwrap(),
                name
            );
        }
    }

    #[test]
    fn creates_one_project_directory_under_its_parent() {
        let parent =
            std::env::temp_dir().join(format!("jyycode-project-path-{}", rand::random::<u64>()));
        fs::create_dir(&parent).unwrap();

        let result =
            create_project_directory(parent.to_string_lossy().into_owned(), "project".into())
                .unwrap();
        assert_eq!(
            fs::canonicalize(result).unwrap(),
            fs::canonicalize(parent.join("project")).unwrap()
        );

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn validates_only_absolute_jyycode_config_files() {
        assert!(
            validate_global_config_file_for(
                r"C:\Users\dev\.config\jyycode\jyycode.jsonc",
                PathPlatform::Windows
            )
            .is_ok()
        );
        assert!(
            validate_global_config_file_for(
                r"C:\Users\dev\.config\jyycode\jyycode.json",
                PathPlatform::Windows
            )
            .is_ok()
        );
        assert!(
            validate_global_config_file_for(
                r"C:\Users\dev\.config\jyycode\other.json",
                PathPlatform::Windows
            )
            .is_err()
        );
        assert!(validate_global_config_file_for("jyycode.jsonc", PathPlatform::Windows).is_err());
        assert!(
            validate_global_config_file_for(
                "/Users/dev/.config/jyycode/jyycode.jsonc",
                PathPlatform::MacOS
            )
            .is_ok()
        );
        assert!(
            validate_global_config_file_for(
                "/Users/dev/.config/jyycode/other.json",
                PathPlatform::MacOS
            )
            .is_err()
        );
        assert!(validate_global_config_file_for("jyycode.jsonc", PathPlatform::MacOS).is_err());
    }

    #[test]
    fn explorer_selection_uses_a_fixed_executable_and_argument_array() {
        let (program, arguments) = reveal_command_for(
            r"C:\Users\dev\.config\jyycode\jyycode.jsonc",
            PathPlatform::Windows,
        )
        .unwrap();
        assert_eq!(program, "explorer.exe");
        assert_eq!(arguments[0], "/select,");
        assert_eq!(arguments[1], r"C:\Users\dev\.config\jyycode\jyycode.jsonc");
    }

    #[test]
    fn finder_selection_uses_a_fixed_executable_and_argument_array() {
        let path = "/Users/dev/.config/jyycode/jyycode.jsonc";
        let (program, arguments) = reveal_command_for(path, PathPlatform::MacOS).unwrap();
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(arguments[0], "-R");
        assert_eq!(arguments[1], path);
    }
}
