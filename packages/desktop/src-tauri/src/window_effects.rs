use serde::Serialize;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectsBuilder};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GlassEffect {
    Acrylic,
    MicaDark,
    MicaLight,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlassTheme {
    Dark,
    Light,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassResult {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

fn select_effect(windows_build: u32, theme: GlassTheme) -> Option<GlassEffect> {
    if windows_build >= 22_000 {
        return Some(match theme {
            GlassTheme::Dark => GlassEffect::MicaDark,
            GlassTheme::Light => GlassEffect::MicaLight,
        });
    }
    if windows_build >= 10_240 {
        return Some(GlassEffect::Acrylic);
    }
    None
}

fn effect_config(effect: GlassEffect) -> WindowEffectsConfig {
    let effect = match effect {
        GlassEffect::Acrylic => Effect::Acrylic,
        GlassEffect::MicaDark => Effect::MicaDark,
        GlassEffect::MicaLight => Effect::MicaLight,
    };
    EffectsBuilder::new().effect(effect).build()
}

#[tauri::command]
pub fn set_window_glass(
    window: tauri::Window,
    enabled: bool,
    theme: GlassTheme,
) -> Result<GlassResult, String> {
    if window.label() != "main" {
        return Ok(GlassResult {
            supported: false,
            reason: Some("Window glass is restricted to the main window".into()),
        });
    }

    if !enabled {
        window
            .set_effects(None::<WindowEffectsConfig>)
            .map_err(|error| error.to_string())?;
        return Ok(GlassResult {
            supported: true,
            reason: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let version = windows_version::OsVersion::current();
        let Some(effect) = select_effect(version.build, theme) else {
            return Ok(GlassResult {
                supported: false,
                reason: Some(format!("Windows build {} does not support glass", version.build)),
            });
        };
        window
            .set_effects(effect_config(effect))
            .map_err(|error| error.to_string())?;
        Ok(GlassResult {
            supported: true,
            reason: None,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = theme;
        Ok(GlassResult {
            supported: false,
            reason: Some("Window glass is supported only on Windows".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{select_effect, GlassEffect, GlassTheme};

    #[test]
    fn chooses_theme_specific_mica_on_windows_11() {
        assert_eq!(select_effect(22_000, GlassTheme::Dark), Some(GlassEffect::MicaDark));
        assert_eq!(select_effect(26_100, GlassTheme::Light), Some(GlassEffect::MicaLight));
    }

    #[test]
    fn chooses_acrylic_on_supported_windows_10() {
        assert_eq!(select_effect(19_045, GlassTheme::Dark), Some(GlassEffect::Acrylic));
        assert_eq!(select_effect(10_240, GlassTheme::Light), Some(GlassEffect::Acrylic));
    }

    #[test]
    fn rejects_unsupported_windows_builds() {
        assert_eq!(select_effect(10_239, GlassTheme::Dark), None);
    }
}
