use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct SaveTextFileResult {
    supported: bool,
    saved: bool,
}

fn json_filename(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Suggested file name cannot be empty".into());
    }
    let path = Path::new(trimmed);
    if path.file_name().and_then(|name| name.to_str()) != Some(trimmed) {
        return Err("Suggested file name must not contain a directory".into());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Suggested file name is invalid".to_string())?;
    Ok(format!("{stem}.json"))
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
    use super::json_filename;

    #[test]
    fn forces_json_extension() {
        assert_eq!(json_filename("memory.txt").unwrap(), "memory.json");
        assert_eq!(json_filename("memory.json").unwrap(), "memory.json");
    }

    #[test]
    fn rejects_empty_or_directory_suggestions() {
        assert!(json_filename("").is_err());
        assert!(json_filename("folder/memory.json").is_err());
        assert!(json_filename(r"folder\memory.json").is_err());
    }
}
