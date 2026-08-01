use serde::Serialize;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState, EffectsBuilder};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GlassEffect {
    Acrylic,
    MicaDark,
    MicaLight,
    #[allow(dead_code)]
    UnderWindowBackground,
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
    match effect {
        GlassEffect::Acrylic => EffectsBuilder::new().effect(Effect::Acrylic).build(),
        GlassEffect::MicaDark => EffectsBuilder::new().effect(Effect::MicaDark).build(),
        GlassEffect::MicaLight => EffectsBuilder::new().effect(Effect::MicaLight).build(),
        GlassEffect::UnderWindowBackground => EffectsBuilder::new()
            .effect(Effect::UnderWindowBackground)
            .state(EffectState::FollowsWindowActiveState)
            .build(),
    }
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
                reason: Some(format!(
                    "Windows build {} does not support glass",
                    version.build
                )),
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

    #[cfg(target_os = "macos")]
    {
        let _ = theme;
        window
            .set_effects(effect_config(GlassEffect::UnderWindowBackground))
            .map_err(|error| error.to_string())?;
        Ok(GlassResult {
            supported: true,
            reason: None,
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = theme;
        Ok(GlassResult {
            supported: false,
            reason: Some("Window glass is supported only on Windows and macOS".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use tauri::window::{Effect, EffectState};

    use super::{GlassEffect, GlassTheme, effect_config, select_effect};

    #[test]
    fn chooses_theme_specific_mica_on_windows_11() {
        assert_eq!(
            select_effect(22_000, GlassTheme::Dark),
            Some(GlassEffect::MicaDark)
        );
        assert_eq!(
            select_effect(26_100, GlassTheme::Light),
            Some(GlassEffect::MicaLight)
        );
    }

    #[test]
    fn chooses_acrylic_on_supported_windows_10() {
        assert_eq!(
            select_effect(19_045, GlassTheme::Dark),
            Some(GlassEffect::Acrylic)
        );
        assert_eq!(
            select_effect(10_240, GlassTheme::Light),
            Some(GlassEffect::Acrylic)
        );
    }

    #[test]
    fn rejects_unsupported_windows_builds() {
        assert_eq!(select_effect(10_239, GlassTheme::Dark), None);
    }

    #[test]
    fn macos_glass_uses_under_window_background_and_follows_activation() {
        let config = effect_config(GlassEffect::UnderWindowBackground);
        assert_eq!(config.effects, vec![Effect::UnderWindowBackground]);
        assert_eq!(config.state, Some(EffectState::FollowsWindowActiveState));
    }
}
