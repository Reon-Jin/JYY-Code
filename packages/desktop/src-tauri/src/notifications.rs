use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use tauri_plugin_notification::NotificationExt;

#[cfg(any(windows, test))]
const APP_USER_MODEL_ID: &str = "ai.jyycode.desktop";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotification {
    title: String,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilityResult {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[tauri::command]
pub fn send_desktop_notification(
    app: tauri::AppHandle,
    notification: DesktopNotification,
) -> DesktopCapabilityResult {
    #[cfg(windows)]
    {
        let _ = app;
        return match notify_rust::Notification::new()
            .app_id(APP_USER_MODEL_ID)
            .summary(&notification.title)
            .body(&notification.body)
            .show()
        {
            Ok(_) => DesktopCapabilityResult {
                supported: true,
                reason: None,
            },
            Err(error) => DesktopCapabilityResult {
                supported: false,
                reason: Some(error.to_string()),
            },
        };
    }

    #[cfg(target_os = "macos")]
    {
        return match app
            .notification()
            .builder()
            .title(notification.title)
            .body(notification.body)
            .show()
        {
            Ok(()) => DesktopCapabilityResult {
                supported: true,
                reason: None,
            },
            Err(error) => DesktopCapabilityResult {
                supported: false,
                reason: Some(error.to_string()),
            },
        };
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        let _ = notification;
        DesktopCapabilityResult {
            supported: false,
            reason: Some("Native desktop notifications are not supported on this platform".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::APP_USER_MODEL_ID;

    #[test]
    fn uses_the_installed_application_identity() {
        assert_eq!(APP_USER_MODEL_ID, "ai.jyycode.desktop");
    }
}
