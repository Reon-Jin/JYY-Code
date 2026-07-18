use serde::{Deserialize, Serialize};

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
pub fn send_desktop_notification(notification: DesktopNotification) -> DesktopCapabilityResult {
    #[cfg(windows)]
    {
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

    #[cfg(not(windows))]
    {
        let _ = notification;
        DesktopCapabilityResult {
            supported: false,
            reason: Some("Native desktop notifications are only supported on Windows".into()),
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
