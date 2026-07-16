use std::{fs, path::Path, process::Command};

const WINDOWS_INVALID_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

pub fn validate_project_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("project name is empty or reserved".into());
    }
    if name.ends_with(['.', ' ']) {
        return Err("project name cannot end with a dot or space".into());
    }
    if name
        .chars()
        .any(|character| character.is_control() || WINDOWS_INVALID_CHARACTERS.contains(&character))
    {
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

    Ok(name)
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

pub fn validate_global_config_file(path: &str) -> Result<&str, String> {
    let path_value = Path::new(path);
    if !path_value.is_absolute() {
        return Err("global config path must be absolute".into());
    }
    let Some(name) = path_value.file_name().and_then(|value| value.to_str()) else {
        return Err("global config path has no valid filename".into());
    };
    if !matches!(name, "jyycode.jsonc" | "jyycode.json") {
        return Err("global config path must name jyycode.jsonc or jyycode.json".into());
    }
    Ok(path)
}

pub fn explorer_selection(path: &str) -> Result<(&'static str, [String; 2]), String> {
    let path = validate_global_config_file(path)?;
    Ok(("explorer.exe", ["/select,".into(), path.into()]))
}

#[tauri::command]
pub fn reveal_config_file(path: String) -> Result<(), String> {
    let (program, arguments) = explorer_selection(&path)?;
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
        create_project_directory, explorer_selection, validate_global_config_file,
        validate_project_name,
    };

    #[test]
    fn rejects_unsafe_windows_project_names() {
        for name in [
            "", ".", "..", "a/b", "a\\b", "CON", "con.txt", "COM1", "lpt9.md", "name.", "name ",
            "a:b",
        ] {
            assert!(validate_project_name(name).is_err(), "accepted {name}");
        }
        assert_eq!(validate_project_name("my-project").unwrap(), "my-project");
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
        assert!(validate_global_config_file(r"C:\Users\dev\.config\jyycode\jyycode.jsonc").is_ok());
        assert!(validate_global_config_file(r"C:\Users\dev\.config\jyycode\jyycode.json").is_ok());
        assert!(validate_global_config_file(r"C:\Users\dev\.config\jyycode\other.json").is_err());
        assert!(validate_global_config_file(r"jyycode.jsonc").is_err());
    }

    #[test]
    fn explorer_selection_uses_a_fixed_executable_and_argument_array() {
        let (program, arguments) =
            explorer_selection(r"C:\Users\dev\.config\jyycode\jyycode.jsonc").unwrap();
        assert_eq!(program, "explorer.exe");
        assert_eq!(arguments[0], "/select,");
        assert_eq!(arguments[1], r"C:\Users\dev\.config\jyycode\jyycode.jsonc");
    }
}
