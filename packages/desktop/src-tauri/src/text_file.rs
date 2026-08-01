use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct SaveTextFileResult {
    supported: bool,
    saved: bool,
}

#[derive(Clone, Copy)]
enum FilenamePlatform {
    Windows,
    #[allow(dead_code)]
    MacOS,
}

fn current_platform() -> FilenamePlatform {
    #[cfg(target_os = "windows")]
    {
        FilenamePlatform::Windows
    }
    #[cfg(not(target_os = "windows"))]
    {
        FilenamePlatform::MacOS
    }
}

fn json_filename_for(value: &str, platform: FilenamePlatform) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Suggested file name cannot be empty".into());
    }
    if trimmed.chars().any(|character| {
        character.is_control()
            || character == '/'
            || (matches!(platform, FilenamePlatform::Windows)
                && matches!(character, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    }) {
        return Err("Suggested file name must not contain a directory".into());
    }
    let stem = trimmed.rsplit_once('.').map_or(trimmed, |(stem, _)| stem);
    if stem.is_empty() || matches!(stem, "." | "..") {
        return Err("Suggested file name is invalid".into());
    }
    Ok(format!("{stem}.json"))
}

fn json_filename(value: &str) -> Result<String, String> {
    json_filename_for(value, current_platform())
}

#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<SaveTextFileResult, String> {
    let filename = json_filename(&suggested_name)?;
    let selected = app
        .dialog()
        .file()
        .set_file_name(filename)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(SaveTextFileResult {
            supported: true,
            saved: false,
        });
    };
    let mut target = selected
        .into_path()
        .map_err(|_| "The selected save target is not a local file".to_string())?;
    if target.as_os_str().is_empty() || target.is_dir() {
        return Err("The selected save target must be a file".into());
    }
    target.set_extension("json");
    std::fs::write(&target, contents).map_err(|error| format!("Unable to save memory export: {error}"))?;
    Ok(SaveTextFileResult {
        supported: true,
        saved: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{FilenamePlatform, json_filename, json_filename_for};

    #[test]
    fn forces_json_extension() {
        assert_eq!(json_filename("memory.txt").unwrap(), "memory.json");
        assert_eq!(json_filename("memory.json").unwrap(), "memory.json");
    }

    #[test]
    fn rejects_empty_or_directory_suggestions() {
        assert!(json_filename("").is_err());
        assert!(json_filename("folder/memory.json").is_err());
    }

    #[test]
    fn applies_platform_separator_rules_to_suggested_names() {
        assert!(json_filename_for(r"folder\memory.json", FilenamePlatform::Windows).is_err());
        assert_eq!(
            json_filename_for(r"folder\memory.json", FilenamePlatform::MacOS).unwrap(),
            r"folder\memory.json"
        );
    }
}
