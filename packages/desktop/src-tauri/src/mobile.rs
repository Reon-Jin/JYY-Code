use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce, aead::Aead};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
#[cfg(not(test))]
use keyring::Entry;
use rand::Rng;
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::backend::BackendSupervisor;

#[cfg(not(test))]
const KEYRING_SERVICE: &str = "ai.jyycode.desktop.mobile";
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const RELAY_URL: &str = "wss://relay.jyycode.ai/connect";
static RELAY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevice {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub paired_at: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingInvitation {
    pub route_id: String,
    pub relay_url: String,
    pub pairing_secret: String,
    pub temporary_public_key: String,
    pub expires_at: u64,
    pub qr_payload: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub pairing_secret: String,
    pub device_id: String,
    pub device_name: String,
    pub public_key: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCompanionStatus {
    pub route_id: String,
    pub relay_url: String,
    pub tunnel_ready: bool,
    pub paired_devices: usize,
    pub pending_pairing_expires_at: Option<u64>,
}

struct PendingPairing {
    secret: String,
    temporary_private_key: StaticSecret,
    expires_at: u64,
}

struct MobileState {
    route_id: String,
    devices: BTreeMap<String, MobileDevice>,
    pending: Option<PendingPairing>,
    executed_commands: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone)]
pub struct MobileCompanion {
    storage_path: PathBuf,
    state: Arc<Mutex<MobileState>>,
}

impl MobileCompanion {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("failed to find mobile companion storage: {error}"))?;
        Self::load_from_directory(&data_dir)
    }

    fn load_from_directory(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory)
            .map_err(|error| format!("failed to create mobile companion storage: {error}"))?;
        let storage_path = directory.join("mobile-devices.json");
        let saved = read_saved(&storage_path)?;
        #[cfg(not(test))]
        ensure_identity(&saved.route_id)?;
        Ok(Self {
            storage_path,
            state: Arc::new(Mutex::new(MobileState {
                route_id: saved.route_id,
                devices: saved
                    .devices
                    .into_iter()
                    .map(|device| (device.id.clone(), device))
                    .collect(),
                pending: None,
                executed_commands: BTreeMap::new(),
            })),
        })
    }

    fn list_devices(&self) -> Result<Vec<MobileDevice>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        Ok(state.devices.values().cloned().collect())
    }

    fn start_pairing(&self) -> Result<MobilePairingInvitation, String> {
        // A Quick Tunnel gets a fresh hostname after every desktop launch.
        // Never create a QR code until its launcher has written that hostname;
        // otherwise a user could pair against the retired development relay.
        #[cfg(not(test))]
        let relay_url = configured_mobile_relay_url()
            .ok_or("Safari 移动网页连接正在启动，请稍候几秒后重试。")?;
        // Protocol unit tests intentionally run without a Windows tunnel.
        #[cfg(test)]
        let relay_url = mobile_relay_url();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        // The browser validates this as a 32-byte (64 hexadecimal character)
        // pairing secret.  Keep the desktop invitation at the same strength so
        // scanned and manually pasted invitations are accepted consistently.
        let secret = random_hex(64);
        let private_key = StaticSecret::from(random_bytes());
        let public_key = PublicKey::from(&private_key);
        let expires_at = now_seconds() + PAIRING_TTL.as_secs();
        state.pending = Some(PendingPairing {
            secret: secret.clone(),
            temporary_private_key: private_key,
            expires_at,
        });
        let invitation = MobilePairingInvitation {
            route_id: state.route_id.clone(),
            relay_url,
            pairing_secret: secret,
            temporary_public_key: to_hex(public_key.as_bytes()),
            expires_at,
            qr_payload: String::new(),
        };
        Ok(MobilePairingInvitation {
            qr_payload: serde_json::to_string(&invitation).map_err(|error| error.to_string())?,
            ..invitation
        })
    }

    fn pairing_status(&self) -> Result<MobileCompanionStatus, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.expires_at <= now_seconds())
        {
            state.pending = None;
        }
        let configured_relay_url = configured_mobile_relay_url();
        let tunnel_ready = configured_relay_url.is_some();
        Ok(MobileCompanionStatus {
            route_id: state.route_id.clone(),
            relay_url: configured_relay_url.unwrap_or_default(),
            tunnel_ready,
            paired_devices: state.devices.len(),
            pending_pairing_expires_at: state.pending.as_ref().map(|pending| pending.expires_at),
        })
    }

    fn complete_pairing(&self, request: PairingRequest) -> Result<MobileDevice, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        let Some(pending) = state.pending.take() else {
            return Err("no mobile pairing is active".into());
        };
        if pending.expires_at <= now_seconds() {
            return Err("mobile pairing has expired".into());
        }
        if pending.secret != request.pairing_secret {
            return Err("mobile pairing secret does not match".into());
        }
        let phone_public_key = parse_public_key(&request.public_key)?;
        // Ensure the phone public key can complete the X25519 handshake before
        // persisting it. Long-lived desktop identity material lives in Keychain
        // or Windows Credential Manager through `keyring`, never in this file.
        let shared_secret = pending
            .temporary_private_key
            .diffie_hellman(&phone_public_key);
        let session_key = derive_session_key(shared_secret.as_bytes(), &pending.secret)?;
        if request.device_id.trim().is_empty() || request.device_id.len() > 128 {
            return Err("mobile device id is invalid".into());
        }
        if request.device_name.trim().is_empty() || request.device_name.len() > 128 {
            return Err("mobile device name is invalid".into());
        }
        let device = MobileDevice {
            id: request.device_id,
            name: request.device_name,
            public_key: request.public_key,
            paired_at: now_seconds(),
        };
        state.devices.insert(device.id.clone(), device.clone());
        store_session_key(&state.route_id, &device.id, &session_key)?;
        self.save(&state)?;
        Ok(device)
    }

    fn decrypt_pairing_request(&self, envelope: &RelayEnvelope) -> Result<PairingRequest, String> {
        let pairing_public_key = envelope
            .pairing_public_key
            .as_deref()
            .ok_or("mobile pairing request is missing its temporary public key")?;
        let phone_public_key = parse_public_key(pairing_public_key)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        let pending = state
            .pending
            .as_ref()
            .ok_or("no mobile pairing is active")?;
        if pending.expires_at <= now_seconds() {
            return Err("mobile pairing has expired".into());
        }
        let shared_secret = pending
            .temporary_private_key
            .diffie_hellman(&phone_public_key);
        let key = derive_session_key(shared_secret.as_bytes(), &pending.secret)?;
        let plaintext = decrypt(&key, &envelope.ciphertext)?;
        let request: PairingWireRequest =
            serde_json::from_slice(&plaintext).map_err(|_| "mobile pairing request is invalid")?;
        if request.kind != "pair" || request.public_key != pairing_public_key {
            return Err("mobile pairing request did not match the public key".into());
        }
        Ok(PairingRequest {
            pairing_secret: request.pairing_secret,
            device_id: request.device_id,
            device_name: request.device_name,
            public_key: request.public_key,
        })
    }

    fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        if state.devices.remove(device_id).is_none() {
            return Err("mobile device does not exist".into());
        }
        // Revocation has to remove both the routing metadata and the secret
        // required to decrypt a future envelope. Keeping the latter would let a
        // stale local route become usable again if metadata were restored.
        remove_session_key(&state.route_id, device_id)?;
        self.save(&state)
    }

    fn claim_command(&self, device_id: &str, command_id: &str) -> Result<bool, String> {
        if command_id.is_empty() || command_id.len() > 128 {
            return Err("mobile command id is invalid".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "mobile companion state is unavailable")?;
        let commands = state.executed_commands.entry(device_id.into()).or_default();
        if commands.contains(command_id) {
            return Ok(false);
        }
        commands.insert(command_id.into());
        // The relay never queues commands. This bounded in-memory cache only
        // makes reconnect/retry delivery idempotent for the running desktop.
        if commands.len() > 1_000 {
            if let Some(oldest) = commands.iter().next().cloned() {
                commands.remove(&oldest);
            }
        }
        Ok(true)
    }

    fn save(&self, state: &MobileState) -> Result<(), String> {
        let saved = SavedMobileState {
            route_id: state.route_id.clone(),
            devices: state.devices.values().cloned().collect(),
        };
        let contents = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
        fs::write(&self.storage_path, contents)
            .map_err(|error| format!("failed to save mobile devices: {error}"))
    }
}

/// Resolve the current relay every time instead of baking a development tunnel
/// URL into a pairing QR. The small local file lets the Windows tunnel launcher
/// update an already-running desktop UI without exposing a relay address in any
/// remote service.
fn mobile_relay_url() -> String {
    configured_mobile_relay_url()
        .or_else(|| std::env::var("JYYCODE_MOBILE_RELAY_URL").ok())
        .unwrap_or_else(|| RELAY_URL.into())
}

fn configured_mobile_relay_url() -> Option<String> {
    let configured_file = std::env::var("JYYCODE_MOBILE_RELAY_FILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|directory| PathBuf::from(directory).join("JYYCode").join("mobile-relay-url.txt"))
        });
    if let Some(path) = configured_file {
        if let Ok(value) = fs::read_to_string(path) {
            let value = value.trim();
            if value.starts_with("wss://") && value.len() <= 2_048 {
                return Some(value.into());
            }
        }
    }
    None
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedMobileState {
    route_id: String,
    #[serde(default)]
    devices: Vec<MobileDevice>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayEnvelope {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u8,
    route_id: String,
    sender_id: String,
    recipient_id: String,
    #[serde(rename = "messageId")]
    _message_id: String,
    correlation_id: Option<String>,
    pairing_public_key: Option<String>,
    #[serde(rename = "sequence")]
    _sequence: u64,
    ciphertext: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingWireRequest {
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    device_name: String,
    public_key: String,
    pairing_secret: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileCommand {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    task_id: String,
    action: MobileAction,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum MobileAction {
    CreateTask { workspace: String, prompt: String },
    SendMessage { message: String },
    Stop,
    Retry,
    ApprovePermission { id: String, approved: bool },
    AnswerQuestion { id: String, answer: String },
    LoadConversation,
    LoadDiff,
    RevokeDevice,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayHello<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    protocol_version: u8,
    route_id: &'a str,
    client_id: &'a str,
    role: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayResponseEnvelope<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    protocol_version: u8,
    route_id: &'a str,
    sender_id: &'a str,
    recipient_id: &'a str,
    message_id: String,
    correlation_id: Option<&'a str>,
    sequence: u64,
    ciphertext: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayPushToken<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    protocol_version: u8,
    route_id: &'a str,
    device_id: &'a str,
    token: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayNotification<'a> {
    #[serde(rename = "type")]
    message_type: &'a str,
    protocol_version: u8,
    route_id: &'a str,
    device_id: &'a str,
    kind: &'a str,
}

fn read_saved(path: &Path) -> Result<SavedMobileState, String> {
    let Ok(contents) = fs::read(path) else {
        return Ok(SavedMobileState {
            route_id: format!("desktop_{}", random_hex(16)),
            devices: Vec::new(),
        });
    };
    serde_json::from_slice(&contents)
        .map_err(|error| format!("failed to read mobile devices: {error}"))
}

#[cfg(not(test))]
fn ensure_identity(route_id: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, route_id)
        .map_err(|error| format!("failed to access credential vault: {error}"))?;
    if entry.get_password().is_ok() {
        return Ok(());
    }
    entry
        .set_password(&random_hex(64))
        .map_err(|error| format!("failed to store mobile identity: {error}"))
}

#[cfg(not(test))]
fn store_session_key(route_id: &str, device_id: &str, key: &[u8; 32]) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &format!("{route_id}:{device_id}"))
        .map_err(|error| format!("failed to access credential vault: {error}"))?;
    entry
        .set_password(&to_hex(key))
        .map_err(|error| format!("failed to store paired mobile key: {error}"))
}

#[cfg(test)]
fn store_session_key(_route_id: &str, _device_id: &str, _key: &[u8; 32]) -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn remove_session_key(route_id: &str, device_id: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &format!("{route_id}:{device_id}"))
        .map_err(|error| format!("failed to access credential vault: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to remove paired mobile key: {error}")),
    }
}

#[cfg(test)]
fn remove_session_key(_route_id: &str, _device_id: &str) -> Result<(), String> {
    Ok(())
}

fn derive_session_key(shared_secret: &[u8], pairing_secret: &str) -> Result<[u8; 32], String> {
    let hkdf = Hkdf::<Sha256>::new(Some(pairing_secret.as_bytes()), shared_secret);
    let mut key = [0; 32];
    hkdf.expand(b"JYYCodeMobilePairing-v1", &mut key)
        .map_err(|_| "failed to derive mobile session key")?;
    Ok(key)
}

fn decrypt(key: &[u8; 32], ciphertext: &str) -> Result<Vec<u8>, String> {
    let data = BASE64
        .decode(ciphertext)
        .map_err(|_| "mobile ciphertext is invalid")?;
    if data.len() <= 12 {
        return Err("mobile ciphertext is invalid".into());
    }
    let cipher =
        ChaCha20Poly1305::new_from_slice(key).map_err(|_| "mobile session key is invalid")?;
    cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "mobile ciphertext could not be decrypted".into())
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher =
        ChaCha20Poly1305::new_from_slice(key).map_err(|_| "mobile session key is invalid")?;
    let nonce = random_nonce();
    let mut combined = nonce.to_vec();
    combined.extend(
        cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| "mobile payload could not be encrypted")?,
    );
    Ok(BASE64.encode(combined))
}

fn random_nonce() -> [u8; 12] {
    let mut nonce = [0; 12];
    rand::rng().fill_bytes(&mut nonce);
    nonce
}

#[cfg(not(test))]
fn load_session_key(route_id: &str, device_id: &str) -> Result<[u8; 32], String> {
    let entry = Entry::new(KEYRING_SERVICE, &format!("{route_id}:{device_id}"))
        .map_err(|error| format!("failed to access credential vault: {error}"))?;
    let value = entry
        .get_password()
        .map_err(|_| "paired mobile device is no longer authorized")?;
    let bytes = from_hex(&value)?;
    bytes
        .try_into()
        .map_err(|_| "paired mobile key is invalid".into())
}

#[cfg(test)]
fn load_session_key(_route_id: &str, _device_id: &str) -> Result<[u8; 32], String> {
    Err("paired mobile device is no longer authorized".into())
}

fn parse_public_key(value: &str) -> Result<PublicKey, String> {
    let bytes = from_hex(value)?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "mobile public key must be 32 bytes")?;
    Ok(PublicKey::from(array))
}

fn random_bytes() -> [u8; 32] {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

fn random_hex(length: usize) -> String {
    to_hex(&random_bytes())[..length].to_owned()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("mobile public key must be hexadecimal".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "mobile public key must be hexadecimal".into())
        })
        .collect()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn next_relay_sequence() -> u64 {
    let wall_clock = now_seconds().saturating_mul(1_000);
    let mut previous = RELAY_SEQUENCE.load(Ordering::SeqCst);
    loop {
        let next = previous.max(wall_clock.saturating_sub(1)).saturating_add(1);
        match RELAY_SEQUENCE.compare_exchange(previous, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return next,
            Err(actual) => previous = actual,
        }
    }
}

pub fn start_relay(companion: MobileCompanion, backend: BackendSupervisor) {
    tauri::async_runtime::spawn(async move {
        let event_signal = Arc::new(AtomicBool::new(true));
        let notification_signal = Arc::new(Mutex::new(None));
        start_backend_event_listener(backend.clone(), event_signal.clone(), notification_signal.clone());
        loop {
            if let Err(error) = relay_once(
                companion.clone(),
                backend.clone(),
                event_signal.clone(),
                notification_signal.clone(),
            )
            .await
            {
                // The public relay only handles ciphertext. Keep the operational
                // cause locally so a failed pairing can be diagnosed without
                // exposing message contents, keys, or task data.
                record_relay_diagnostic(&error);
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

#[cfg(windows)]
fn record_relay_diagnostic(error: &str) {
    use std::io::Write;

    let Some(directory) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return;
    };
    let path = directory.join("JYYCode").join("mobile-relay.log");
    let sanitized = error.replace(['\r', '\n'], " ");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {sanitized}", now_seconds());
    }
}

#[cfg(not(windows))]
fn record_relay_diagnostic(_error: &str) {}

async fn relay_once(
    companion: MobileCompanion,
    backend: BackendSupervisor,
    event_signal: Arc<AtomicBool>,
    notification_signal: Arc<Mutex<Option<&'static str>>>,
) -> Result<(), String> {
    let relay_url = mobile_relay_url();
    let (stream, _) = connect_async(&relay_url)
        .await
        .map_err(|error| format!("mobile relay connection failed: {error}"))?;
    let route_id = companion.pairing_status()?.route_id;
    let (mut writer, mut reader) = stream.split();
    let hello = RelayHello {
        kind: "relay.hello",
        protocol_version: 1,
        route_id: &route_id,
        client_id: &route_id,
        role: "desktop",
    };
    writer
        .send(Message::Text(
            serde_json::to_string(&hello)
                .map_err(|error| error.to_string())?
                .into(),
        ))
        .await
        .map_err(|error| format!("mobile relay hello failed: {error}"))?;

    let mut safety_refresh = tokio::time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
        _ = safety_refresh.tick() => {
            if !event_signal.swap(false, Ordering::SeqCst) {
                continue;
            }
            let notification_kind = notification_signal.lock().ok().and_then(|mut kind| kind.take());
            for device in companion.list_devices()? {
                let Ok(key) = load_session_key(&route_id, &device.id) else { continue; };
                let Ok(tasks) = fetch_summary(&backend, &device.id).await else { continue; };
                let payload = serde_json::json!({ "type": "summaryUpdate", "tasks": tasks });
                let response = RelayResponseEnvelope {
                    kind: "relay.envelope",
                    protocol_version: 1,
                    route_id: &route_id,
                    sender_id: &route_id,
                    recipient_id: &device.id,
                    message_id: format!("event_{}", random_hex(16)),
                    correlation_id: None,
                    sequence: next_relay_sequence(),
                    ciphertext: encrypt(&key, &serde_json::to_vec(&payload).map_err(|error| error.to_string())?)?,
                };
                writer.send(Message::Text(serde_json::to_string(&response).map_err(|error| error.to_string())?.into()))
                    .await
                    .map_err(|error| format!("mobile relay event send failed: {error}"))?;
                if let Some(notification_kind) = notification_kind {
                    let notification = RelayNotification {
                        message_type: "relay.notification",
                        protocol_version: 1,
                        route_id: &route_id,
                        device_id: &device.id,
                        kind: notification_kind,
                    };
                    writer.send(Message::Text(serde_json::to_string(&notification).map_err(|error| error.to_string())?.into()))
                        .await
                        .map_err(|error| format!("mobile relay notification send failed: {error}"))?;
                }
            }
        }
        message = reader.next() => {
        let Some(message) = message else { break; };
        let message = message.map_err(|error| format!("mobile relay receive failed: {error}"))?;
        let Message::Text(body) = message else {
            continue;
        };
        let Ok(envelope) = serde_json::from_str::<RelayEnvelope>(&body) else {
            continue;
        };
        if envelope.kind != "relay.envelope"
            || envelope.protocol_version != 1
            || envelope.route_id != route_id
            || envelope.recipient_id != route_id
        {
            continue;
        }
        if envelope.pairing_public_key.is_some() {
            let request = companion.decrypt_pairing_request(&envelope)?;
            if request.device_id != envelope.sender_id {
                continue;
            }
            let device = companion.complete_pairing(request)?;
            let key = load_session_key(&route_id, &device.id)?;
            let response = serde_json::json!({ "type": "pairResult", "ok": true });
            let response = RelayResponseEnvelope {
                kind: "relay.envelope",
                protocol_version: 1,
                route_id: &route_id,
                sender_id: &route_id,
                recipient_id: &device.id,
                message_id: format!("response_{}", random_hex(16)),
                correlation_id: envelope.correlation_id.as_deref(),
                sequence: next_relay_sequence(),
                ciphertext: encrypt(
                    &key,
                    &serde_json::to_vec(&response).map_err(|error| error.to_string())?,
                )?,
            };
            writer
                .send(Message::Text(
                    serde_json::to_string(&response)
                        .map_err(|error| error.to_string())?
                        .into(),
                ))
                .await
                .map_err(|error| format!("mobile relay pairing response failed: {error}"))?;
            continue;
        }

        let key = load_session_key(&route_id, &envelope.sender_id)?;
        let payload = decrypt(&key, &envelope.ciphertext)?;
        let request: serde_json::Value =
            serde_json::from_slice(&payload).map_err(|_| "mobile request is invalid")?;
        if request.get("type").and_then(serde_json::Value::as_str) == Some("summary")
            && let Some(token) = request.get("pushToken").and_then(serde_json::Value::as_str)
            && is_push_token(token)
        {
            let registration = RelayPushToken {
                kind: "relay.push-token",
                protocol_version: 1,
                route_id: &route_id,
                device_id: &envelope.sender_id,
                token,
            };
            writer
                .send(Message::Text(serde_json::to_string(&registration).map_err(|error| error.to_string())?.into()))
                .await
                .map_err(|error| format!("mobile push token registration failed: {error}"))?;
        }
        let response = match request.get("type").and_then(serde_json::Value::as_str) {
            Some("summary") => serde_json::json!({
                "type": "summaryResult",
                "tasks": fetch_summary(&backend, &envelope.sender_id).await?,
            }),
            Some("command") => {
                let command: MobileCommand =
                    serde_json::from_value(request).map_err(|_| "mobile command is invalid")?;
                if command.kind != "command" {
                    return Err("mobile command is invalid".into());
                }
                if !companion.claim_command(&envelope.sender_id, &command.id)? {
                    serde_json::json!({ "type": "commandResult", "id": command.id, "duplicate": true })
                } else if matches!(&command.action, MobileAction::RevokeDevice) {
                    companion.revoke_device(&envelope.sender_id)?;
                    serde_json::json!({ "type": "commandResult", "ok": true })
                } else {
                    match execute_command(&backend, command).await {
                        Ok(data) => serde_json::json!({ "type": "commandResult", "ok": true, "data": data }),
                        Err(error) => {
                            serde_json::json!({ "type": "commandResult", "ok": false, "error": error })
                        }
                    }
                }
            }
            _ => {
                serde_json::json!({ "type": "commandResult", "ok": false, "error": "unsupported mobile request" })
            }
        };
        let ciphertext = encrypt(
            &key,
            &serde_json::to_vec(&response).map_err(|error| error.to_string())?,
        )?;
        let response = RelayResponseEnvelope {
            kind: "relay.envelope",
            protocol_version: 1,
            route_id: &route_id,
            sender_id: &route_id,
            recipient_id: &envelope.sender_id,
            message_id: format!("response_{}", random_hex(16)),
            correlation_id: envelope.correlation_id.as_deref(),
            sequence: next_relay_sequence(),
            ciphertext,
        };
        writer
            .send(Message::Text(
                serde_json::to_string(&response)
                    .map_err(|error| error.to_string())?
                    .into(),
            ))
            .await
            .map_err(|error| format!("mobile relay response failed: {error}"))?;
        }
        }
    }
    Ok(())
}

fn start_backend_event_listener(
    backend: BackendSupervisor,
    signal: Arc<AtomicBool>,
    notification_signal: Arc<Mutex<Option<&'static str>>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(notification_kind) = wait_for_backend_event(&backend).await {
                signal.store(true, Ordering::SeqCst);
                if let Some(notification_kind) = notification_kind
                    && let Ok(mut current) = notification_signal.lock()
                {
                    *current = Some(notification_kind);
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn wait_for_backend_event(backend: &BackendSupervisor) -> Result<Option<&'static str>, String> {
    let bootstrap = backend.bootstrap()?;
    let authorization = BASE64.encode(format!("{}:{}", bootstrap.username, bootstrap.password));
    let response = reqwest::Client::new()
        .get(format!("{}/global/event", bootstrap.base_url.trim_end_matches('/')))
        .header("Authorization", format!("Basic {authorization}"))
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|error| format!("local JYYCode event subscription failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("local JYYCode event subscription failed: {error}"))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("local JYYCode event stream failed: {error}"))?;
        let event = String::from_utf8_lossy(&chunk);
        if event.contains("permission.asked") || event.contains("question.asked") { return Ok(Some("attention")); }
        if event.contains("session.error") || event.contains("workspace.failed") { return Ok(Some("failed")); }
        if event.contains("session.idle") { return Ok(Some("completed")); }
        if ["session.status", "todo.updated", "plan.runtime.event"].iter().any(|kind| event.contains(kind)) { return Ok(None); }
    }
    Err("local JYYCode event stream closed".into())
}

async fn fetch_summary(
    backend: &BackendSupervisor,
    device_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let sessions = local_json(
        backend,
        reqwest::Method::GET,
        "/experimental/session",
        None,
        None,
    )
    .await?;
    let statuses = local_json(backend, reqwest::Method::GET, "/session/status", None, None)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let permissions = local_json(backend, reqwest::Method::GET, "/permission", None, None)
        .await
        .unwrap_or_else(|_| serde_json::json!([]));
    let questions = local_json(backend, reqwest::Method::GET, "/question", None, None)
        .await
        .unwrap_or_else(|_| serde_json::json!([]));
    let sessions = sessions
        .as_array()
        .cloned()
        .ok_or("local JYYCode session response was invalid")?;
    let mut tasks = sessions
        .iter()
        .filter(|session| session.get("parentID").and_then(serde_json::Value::as_str).is_none())
        .map(|session| {
            let id = session.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
            let title = session
                .get("title")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String("未命名任务".into()));
            let updated = session
                .pointer("/time/updated")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(now_seconds);
            let permission = permissions.as_array().and_then(|items| items.iter().find(|item| item.get("sessionID").and_then(serde_json::Value::as_str) == Some(id)));
            let question = questions.as_array().and_then(|items| items.iter().find(|item| item.get("sessionID").and_then(serde_json::Value::as_str) == Some(id)));
            let pending = if let Some(permission) = permission {
                serde_json::json!({ "type": "permission", "id": permission.get("id").and_then(serde_json::Value::as_str).unwrap_or_default(), "title": "需要批准权限" })
            } else if let Some(question) = question {
                let options = question.pointer("/questions/0/options").and_then(serde_json::Value::as_array).map(|options| options.iter().filter_map(|option| option.get("label").and_then(serde_json::Value::as_str)).collect::<Vec<_>>()).unwrap_or_default();
                serde_json::json!({ "type": "question", "id": question.get("id").and_then(serde_json::Value::as_str).unwrap_or_default(), "title": question.pointer("/questions/0/header").and_then(serde_json::Value::as_str).unwrap_or("任务需要回答"), "options": options })
            } else {
                serde_json::Value::Null
            };
            let status_type = statuses.get(id).and_then(|status| status.get("type")).and_then(serde_json::Value::as_str).unwrap_or("idle");
            let status = if !pending.is_null() { "waiting" } else if status_type == "busy" { "running" } else if status_type == "retry" { "failed" } else { "completed" };
            let summary = match status {
                "waiting" => "等待你的处理。",
                "running" => "正在处理任务。",
                "failed" => "任务需要重试。",
                _ => "任务已完成。",
            };
            let children = sessions
                .iter()
                .filter(|child| child.get("parentID").and_then(serde_json::Value::as_str) == Some(id))
                .map(|child| {
                    let child_id = child.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
                    let child_status = match statuses.get(child_id).and_then(|entry| entry.get("type")).and_then(serde_json::Value::as_str) {
                        Some("busy") => "running",
                        Some("retry") => "failed",
                        _ => "idle",
                    };
                    serde_json::json!({
                        "id": child_id,
                        "title": child.get("title").and_then(serde_json::Value::as_str).unwrap_or("未命名子任务"),
                        "status": child_status,
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "id": id,
                "deviceID": device_id,
                "project": session.get("directory").or_else(|| session.get("workspace")).and_then(serde_json::Value::as_str).unwrap_or("未命名项目"),
                "title": title,
                "status": status,
                "summary": summary,
                "progress": 0,
                "updatedAt": iso8601_seconds(updated),
                "todo": [],
                "children": children,
                "pending": pending,
                "timeline": [{ "id": format!("{id}-synced"), "title": "任务状态已同步", "date": iso8601_seconds(updated) }],
            })
        })
        .collect::<Vec<_>>();
    for task in &mut tasks {
        let Some(id) = task.get("id").and_then(serde_json::Value::as_str) else { continue; };
        let todo = local_json(
            backend,
            reqwest::Method::GET,
            &format!("/session/{id}/todo"),
            None,
            None,
        )
        .await
        .unwrap_or_else(|_| serde_json::json!([]));
        let items = todo
            .as_array()
            .map(|items| items.iter().enumerate().map(|(index, item)| serde_json::json!({
                "id": format!("{id}-todo-{index}"),
                "title": item.get("content").and_then(serde_json::Value::as_str).unwrap_or("待办事项"),
                "isComplete": item.get("status").and_then(serde_json::Value::as_str) == Some("completed"),
            })).collect::<Vec<_>>())
            .unwrap_or_default();
        task["todo"] = serde_json::Value::Array(items);
        let (completed, total) = task["todo"]
            .as_array()
            .map(|items| {
                (
                    items.iter().filter(|item| item.get("isComplete") == Some(&serde_json::Value::Bool(true))).count(),
                    items.len(),
                )
            })
            .unwrap_or((0, 0));
        if total > 0 {
            task["progress"] = serde_json::json!(completed as f64 / total as f64);
        }
    }
    Ok(tasks)
}

async fn execute_command(
    backend: &BackendSupervisor,
    command: MobileCommand,
) -> Result<Option<serde_json::Value>, String> {
    match command.action {
        MobileAction::CreateTask { workspace, prompt } => {
            validate_text(&workspace, "workspace")?;
            validate_text(&prompt, "prompt")?;
            let created = local_json(
                backend,
                reqwest::Method::POST,
                "/session",
                Some(&workspace),
                Some(serde_json::json!({ "title": short_title(&prompt) })),
            )
            .await?;
            let session_id = created
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or("desktop did not create a task")?;
            local_json(
                backend,
                reqwest::Method::POST,
                &format!("/session/{session_id}/prompt_async"),
                Some(&workspace),
                Some(serde_json::json!({ "parts": [{ "type": "text", "text": prompt }] })),
            )
            .await?;
        }
        MobileAction::SendMessage { message } => {
            validate_text(&message, "message")?;
            local_json(
                backend,
                reqwest::Method::POST,
                &format!("/session/{}/prompt_async", command.task_id),
                None,
                Some(serde_json::json!({ "parts": [{ "type": "text", "text": message }] })),
            )
            .await?;
        }
        MobileAction::Stop => {
            local_json(
                backend,
                reqwest::Method::POST,
                &format!("/session/{}/abort", command.task_id),
                None,
                None,
            )
            .await?;
        }
        MobileAction::Retry => {
            local_json(backend, reqwest::Method::POST, &format!("/session/{}/prompt_async", command.task_id), None, Some(serde_json::json!({ "parts": [{ "type": "text", "text": "Please continue the task." }] }))).await?;
        }
        MobileAction::ApprovePermission { id, approved } => {
            local_json(
                backend,
                reqwest::Method::POST,
                &format!("/permission/{id}/reply"),
                None,
                Some(serde_json::json!({ "reply": if approved { "once" } else { "reject" } })),
            )
            .await?;
        }
        MobileAction::AnswerQuestion { id, answer } => {
            validate_text(&answer, "answer")?;
            local_json(
                backend,
                reqwest::Method::POST,
                &format!("/question/{id}/reply"),
                None,
                Some(serde_json::json!({ "answers": [[answer]] })),
            )
            .await?;
        }
        MobileAction::LoadConversation => {
            let messages = local_json(
                backend,
                reqwest::Method::GET,
                &format!("/session/{}/message?limit=200", command.task_id),
                None,
                None,
            )
            .await?;
            return Ok(Some(serde_json::json!({
                "kind": "conversation",
                "content": serde_json::to_string(&messages).map_err(|error| error.to_string())?,
            })));
        }
        MobileAction::LoadDiff => {
            let diff = local_json(
                backend,
                reqwest::Method::GET,
                &format!("/session/{}/diff", command.task_id),
                None,
                None,
            )
            .await?;
            return Ok(Some(serde_json::json!({
                "kind": "diff",
                "content": serde_json::to_string(&diff).map_err(|error| error.to_string())?,
            })));
        }
        MobileAction::RevokeDevice => return Err("mobile device revocation must be handled by the relay".into()),
    }
    Ok(None)
}

async fn local_json(
    backend: &BackendSupervisor,
    method: reqwest::Method,
    path: &str,
    directory: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let bootstrap = backend.bootstrap()?;
    let authorization = BASE64.encode(format!("{}:{}", bootstrap.username, bootstrap.password));
    let mut url = format!("{}{}", bootstrap.base_url.trim_end_matches('/'), path);
    if let Some(directory) = directory {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str("directory=");
        url.push_str(&percent_encode(directory));
    }
    let mut request = reqwest::Client::new()
        .request(method, url)
        .header("Authorization", format!("Basic {authorization}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
        .send()
        .await
        .map_err(|error| format!("local JYYCode request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("local JYYCode rejected mobile action: {error}"))?
        .json()
        .await
        .map_err(|error| format!("local JYYCode response was invalid: {error}"))
}

fn validate_text(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 32_000 {
        return Err(format!("mobile {field} is invalid"));
    }
    Ok(())
}

fn short_title(prompt: &str) -> String {
    prompt
        .lines()
        .next()
        .unwrap_or("New task")
        .chars()
        .take(80)
        .collect()
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                format!("{}", byte as char).into_bytes()
            }
            _ => format!("%{byte:02X}").into_bytes(),
        })
        .map(char::from)
        .collect()
}

fn is_push_token(value: &str) -> bool {
    (32..=400).contains(&value.len())
        && value.len().is_multiple_of(2)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn iso8601_seconds(seconds: u64) -> String {
    let seconds = if seconds > 10_000_000_000 {
        seconds / 1000
    } else {
        seconds
    };
    chrono::DateTime::from_timestamp(seconds as i64, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

#[tauri::command]
pub fn mobile_list_devices(
    state: tauri::State<'_, MobileCompanion>,
) -> Result<Vec<MobileDevice>, String> {
    state.inner().list_devices()
}

#[tauri::command]
pub fn mobile_start_pairing(
    state: tauri::State<'_, MobileCompanion>,
) -> Result<MobilePairingInvitation, String> {
    state.inner().start_pairing()
}

#[tauri::command]
pub fn mobile_pairing_status(
    state: tauri::State<'_, MobileCompanion>,
) -> Result<MobileCompanionStatus, String> {
    state.inner().pairing_status()
}

#[tauri::command]
pub fn mobile_complete_pairing(
    state: tauri::State<'_, MobileCompanion>,
    request: PairingRequest,
) -> Result<MobileDevice, String> {
    state.inner().complete_pairing(request)
}

#[tauri::command]
pub fn mobile_revoke_device(
    state: tauri::State<'_, MobileCompanion>,
    device_id: String,
) -> Result<(), String> {
    state.inner().revoke_device(&device_id)
}

#[cfg(test)]
mod tests {
    use super::{
        MobileAction, MobileCompanion, PairingRequest, decrypt, derive_session_key, encrypt,
        percent_encode, random_hex,
    };

    #[test]
    fn emits_a_browser_compatible_pairing_invitation() {
        let directory = tempfile::tempdir().expect("temp directory");
        let companion = MobileCompanion::load_from_directory(directory.path()).expect("companion");
        let invitation = companion.start_pairing().expect("pairing invitation");

        assert_eq!(invitation.pairing_secret.len(), 64);
        assert!(invitation.pairing_secret.chars().all(|character| character.is_ascii_hexdigit()));
        let payload: serde_json::Value =
            serde_json::from_str(&invitation.qr_payload).expect("QR payload JSON");
        assert_eq!(payload["pairingSecret"], invitation.pairing_secret);
    }

    #[test]
    fn rejects_an_incorrect_pairing_secret() {
        let directory = tempfile::tempdir().expect("temp directory");
        let companion = MobileCompanion::load_from_directory(directory.path()).expect("companion");
        let invitation = companion.start_pairing().expect("pairing invitation");
        let result = companion.complete_pairing(PairingRequest {
            pairing_secret: format!("{}wrong", invitation.pairing_secret),
            device_id: "phone_1".into(),
            device_name: "iPhone".into(),
            public_key: random_hex(64),
        });
        assert!(result.is_err());
        assert!(companion.list_devices().expect("devices").is_empty());
    }

    #[test]
    fn persists_and_revokes_a_paired_device() {
        let directory = tempfile::tempdir().expect("temp directory");
        let companion = MobileCompanion::load_from_directory(directory.path()).expect("companion");
        let invitation = companion.start_pairing().expect("pairing invitation");
        companion
            .complete_pairing(PairingRequest {
                pairing_secret: invitation.pairing_secret,
                device_id: "phone_1".into(),
                device_name: "iPhone".into(),
                public_key: random_hex(64),
            })
            .expect("pair device");
        assert_eq!(companion.list_devices().expect("devices").len(), 1);
        companion.revoke_device("phone_1").expect("revoke device");
        assert!(companion.list_devices().expect("devices").is_empty());
    }

    #[test]
    fn encrypts_and_decrypts_a_mobile_payload() {
        let key = derive_session_key(&[7; 32], "pairing-secret").expect("session key");
        let encrypted = encrypt(&key, b"encrypted task summary").expect("encrypt");
        assert_eq!(
            decrypt(&key, &encrypted).expect("decrypt"),
            b"encrypted task summary"
        );
    }

    #[test]
    fn accepts_only_the_mobile_action_allowlist() {
        let action: MobileAction = serde_json::from_value(serde_json::json!({ "type": "stop" }))
            .expect("stop is allowlisted");
        assert!(matches!(action, MobileAction::Stop));
        let action: MobileAction = serde_json::from_value(serde_json::json!({ "type": "revokeDevice" }))
            .expect("self-revocation is allowlisted");
        assert!(matches!(action, MobileAction::RevokeDevice));
        let terminal = serde_json::from_value::<MobileAction>(serde_json::json!({
            "type": "terminal",
            "command": "whoami"
        }));
        assert!(terminal.is_err());
    }

    #[test]
    fn encodes_workspace_query_without_leaking_query_structure() {
        assert_eq!(percent_encode("C:\\work dir?x=1"), "C%3A%5Cwork%20dir%3Fx%3D1");
    }
}
