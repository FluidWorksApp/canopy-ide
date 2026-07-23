// Stand-in for the dictation module on builds without the `dictation` feature
// (Intel macOS — no compatible ONNX Runtime). It mirrors the real module's
// public surface so lib.rs registers the same Tauri commands and manages the
// same state regardless of the feature, and the frontend gets a truthful
// `dictation_supported() == false` (which hides the whole feature in the UI).
// Every command that would do work reports the feature is unavailable; none of
// them are reachable from the UI when `dictation_supported` is false, but they
// stay defined so the command handler compiles.

const UNAVAILABLE: &str = "Voice dictation isn't available in this build.";

#[derive(Default)]
pub struct DictationManager;

#[derive(serde::Serialize)]
pub struct ModelInfo {
    id: String,
    name: String,
    languages: Vec<String>,
    size_mb: u64,
    downloaded: bool,
    multilingual: bool,
    is_default: bool,
}

#[derive(serde::Serialize)]
pub struct DictationStatus {
    recording: bool,
    downloading: Option<String>,
    loaded: Option<String>,
}

/// Whether this build can run dictation. Always false here — the feature is
/// compiled out — so the UI hides dictation entirely.
#[tauri::command]
pub fn dictation_supported() -> bool {
    false
}

#[tauri::command]
pub fn dictation_models() -> Vec<ModelInfo> {
    Vec::new()
}

#[tauri::command]
pub fn dictation_status(_state: tauri::State<'_, DictationManager>) -> DictationStatus {
    DictationStatus {
        recording: false,
        downloading: None,
        loaded: None,
    }
}

#[tauri::command]
pub fn dictation_download(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, DictationManager>,
    _model_id: String,
) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn dictation_delete_model(
    _state: tauri::State<'_, DictationManager>,
    _model_id: String,
) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn dictation_start(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, DictationManager>,
    _model_id: String,
) -> Result<String, String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn dictation_stop(
    _state: tauri::State<'_, DictationManager>,
    _language: Option<String>,
) -> Result<String, String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn dictation_cancel(_state: tauri::State<'_, DictationManager>) {}
