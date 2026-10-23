use tauri_plugin_shell::ShellExt;

fn validate_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid URL".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS links are supported".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_url(&url)?;
    #[allow(deprecated)]
    app.shell()
        .open(url.as_str(), None)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn accepts_only_web_links() {
        assert!(validate_url("https://example.com/path?q=1").is_ok());
        assert!(validate_url("http://localhost:5173").is_ok());
        for value in [
            "file:///C:/Windows/system32/cmd.exe",
            "javascript:alert(1)",
            "cmd.exe",
            "data:text/html,x",
        ] {
            assert!(validate_url(value).is_err());
        }
    }
}
