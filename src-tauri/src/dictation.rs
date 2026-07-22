// Voice dictation, fully local: press the shortcut, speak, press again, and
// the transcription lands at the cursor. Runs on the CPU via ONNX Runtime, so
// the same code path works on macOS/Windows/Linux, Intel and ARM alike. No
// cloud, no formatting pass, no per-app configuration.
//
// One model is installed by default — NVIDIA Parakeet TDT 0.6B v3, multilingual
// — but the registry below offers alternatives (SenseVoice for CJK languages,
// Moonshine for fast English). Each is a tarball fetched on demand into
// ~/.canopy/models/ and loaded lazily on first use, then kept resident. Users
// who never press the shortcut pay nothing.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::sense_voice::SenseVoiceModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

#[derive(Clone, Copy)]
enum Engine {
    Parakeet,
    SenseVoice,
    Moonshine,
}

/// A downloadable ASR model. `url` is a gzipped tarball (the distribution the
/// transcribe-rs project itself publishes); `languages` are BCP-47 codes used
/// both for the UI and as an optional transcription hint. `multilingual`
/// models auto-detect and take the hint only as a nudge; single-language ones
/// ignore it.
struct ModelDef {
    id: &'static str,
    name: &'static str,
    engine: Engine,
    quant: Quantization,
    url: &'static str,
    size_mb: u64,
    languages: &'static [&'static str],
    multilingual: bool,
}

// First entry is the default. Sizes are approximate (for the UI + download
// weighting only). All three are int8/fp32 ONNX exports that run on CPU.
const MODELS: &[ModelDef] = &[
    ModelDef {
        id: "parakeet-v3",
        name: "Parakeet v3 · multilingual",
        engine: Engine::Parakeet,
        quant: Quantization::Int8,
        url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
        size_mb: 700,
        // NVIDIA Parakeet TDT 0.6B v3 covers 25 European languages, auto-detected.
        languages: &[
            "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk", "cs", "sk", "hr", "ro",
            "bg", "hu", "fi", "da", "sv", "el", "et", "lv", "lt", "sl", "mt",
        ],
        multilingual: true,
    },
    ModelDef {
        id: "sensevoice",
        name: "SenseVoice · CJK + English",
        engine: Engine::SenseVoice,
        quant: Quantization::Int8,
        url: "https://blob.handy.computer/sense-voice-int8.tar.gz",
        size_mb: 250,
        languages: &["zh", "yue", "ja", "ko", "en"],
        multilingual: true,
    },
    ModelDef {
        id: "moonshine-base",
        name: "Moonshine Base · English, fast",
        engine: Engine::Moonshine,
        quant: Quantization::FP32,
        url: "https://blob.handy.computer/moonshine-base.tar.gz",
        size_mb: 200,
        languages: &["en"],
        multilingual: false,
    },
];

const TARGET_RATE: u32 = 16_000;
// Bound the capture buffer: 10 minutes of speech at 48 kHz mono f32 is
// ~115 MB. Past the cap the stream keeps running but stops accumulating.
const MAX_SECONDS: u32 = 600;

fn find_def(id: &str) -> Result<&'static ModelDef, String> {
    // Settings store a blank id to mean "the default model" (so a stored id can
    // never pin a since-removed model). Resolve that to the first registered
    // model — otherwise starting dictation before an explicit pick fails with
    // "Unknown dictation model:".
    let id = if id.is_empty() { MODELS[0].id } else { id };
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown dictation model: {id}"))
}

#[derive(Default)]
pub struct DictationManager(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    engine: Option<Box<dyn SpeechModel>>,
    loaded_model: Option<String>,
    recording: Option<Recording>,
    downloading: Option<String>,
}

struct Recording {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    join: std::thread::JoinHandle<()>,
}

fn models_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    Ok(PathBuf::from(home).join(".canopy").join("models"))
}

fn model_dir(id: &str) -> Result<PathBuf, String> {
    Ok(models_root()?.join(id))
}

/// A model counts as installed once extraction wrote the marker. Anything
/// less (a killed download, a partial extract) is treated as absent and
/// re-fetched, so there is no half-installed state to load from.
fn model_ready(id: &str) -> bool {
    model_dir(id).map(|d| d.join(".complete").exists()).unwrap_or(false)
}

/// The tarball may extract its files directly into the model directory or into
/// a single nested folder. Return whichever level actually holds the .onnx
/// files, so load() gets a usable path regardless of the archive's shape.
fn resolve_load_dir(base: &Path) -> PathBuf {
    let has_onnx = |d: &Path| {
        std::fs::read_dir(d)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .any(|e| e.path().extension().is_some_and(|x| x == "onnx"))
            })
            .unwrap_or(false)
    };
    if has_onnx(base) {
        return base.to_path_buf();
    }
    if let Ok(rd) = std::fs::read_dir(base) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() && has_onnx(&p) {
                return p;
            }
        }
    }
    base.to_path_buf()
}

fn emit_progress(app: &tauri::AppHandle, model: &str, phase: &str, pct: f64, message: Option<&str>) {
    let _ = app.emit(
        "dictation:progress",
        serde_json::json!({ "model": model, "phase": phase, "pct": pct, "message": message }),
    );
}

/// Stream the tarball to a temp file (never buffered whole — Parakeet is
/// ~700 MB), extract it, and mark the model complete. Emits download progress
/// as it goes, then an "extract" phase, ending in "ready" or "error".
async fn download_model(app: tauri::AppHandle, def: &'static ModelDef) -> Result<(), String> {
    let dir = model_dir(def.id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    let tmp = dir.join("download.tar.gz.tmp");

    let client = reqwest::Client::new();
    let mut resp = client
        .get(def.url)
        .send()
        .await
        .map_err(|e| format!("download {}: {e}", def.name))?;
    if !resp.status().is_success() {
        return Err(format!("download {}: HTTP {}", def.name, resp.status()));
    }
    let total = resp.content_length().unwrap_or(def.size_mb * 1_000_000).max(1);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
    let mut received: u64 = 0;
    let mut last = -1i64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        received += chunk.len() as u64;
        let pct = (received as f64 / total as f64 * 100.0).min(100.0);
        if pct as i64 > last {
            last = pct as i64;
            emit_progress(&app, def.id, "download", pct, None);
        }
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    drop(file);

    emit_progress(&app, def.id, "extract", 100.0, None);
    // Extract on a blocking thread — gzip inflate + untar of hundreds of MB
    // must not stall the async runtime.
    let extract_dir = dir.clone();
    let tmp_for_extract = tmp.clone();
    tauri::async_runtime::spawn_blocking(move || extract_tar_gz(&tmp_for_extract, &extract_dir))
        .await
        .map_err(|e| e.to_string())??;

    std::fs::remove_file(&tmp).ok();
    std::fs::File::create(dir.join(".complete")).map_err(|e| format!("mark complete: {e}"))?;
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(gz);
    tar.unpack(dest).map_err(|e| format!("extract archive: {e}"))?;
    Ok(())
}

fn load_engine(def: &ModelDef) -> Result<Box<dyn SpeechModel>, String> {
    let dir = resolve_load_dir(&model_dir(def.id)?);
    let engine: Box<dyn SpeechModel> = match def.engine {
        Engine::Parakeet => Box::new(
            ParakeetModel::load(&dir, &def.quant).map_err(|e| format!("load model: {e}"))?,
        ),
        Engine::SenseVoice => Box::new(
            SenseVoiceModel::load(&dir, &def.quant).map_err(|e| format!("load model: {e}"))?,
        ),
        Engine::Moonshine => Box::new(
            MoonshineModel::load(&dir, MoonshineVariant::Base, &def.quant)
                .map_err(|e| format!("load model: {e}"))?,
        ),
    };
    Ok(engine)
}

/// Open the default input device on a dedicated thread (cpal streams are not
/// Send) and accumulate mono samples at the device's native rate until told
/// to stop. Returns once the stream is actually capturing, so "Listening"
/// in the UI never lies about a mic that failed to open.
fn start_capture() -> Result<Recording, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    let thread_stop = stop.clone();
    let thread_samples = samples.clone();

    let join = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let open = || -> Result<(cpal::Stream, u32), String> {
            let device = cpal::default_host()
                .default_input_device()
                .ok_or("No microphone found")?;
            let config = device
                .default_input_config()
                .map_err(|e| format!("Microphone unavailable: {e}"))?;
            let rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let cap = (rate * MAX_SECONDS) as usize;
            let err_fn = |e| log::warn!("dictation: input stream error: {e}");
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let sink = thread_samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &_| push_mono(&sink, data, channels, cap),
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let sink = thread_samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &_| {
                            let f: Vec<f32> =
                                data.iter().map(|s| *s as f32 / 32768.0).collect();
                            push_mono(&sink, &f, channels, cap);
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let sink = thread_samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[u16], _: &_| {
                            let f: Vec<f32> = data
                                .iter()
                                .map(|s| *s as f32 / 32768.0 - 1.0)
                                .collect();
                            push_mono(&sink, &f, channels, cap);
                        },
                        err_fn,
                        None,
                    )
                }
                other => return Err(format!("Unsupported microphone format: {other:?}")),
            }
            .map_err(|e| format!("Could not open microphone: {e}"))?;
            stream.play().map_err(|e| format!("Could not start microphone: {e}"))?;
            Ok((stream, rate))
        };
        match open() {
            Err(e) => {
                let _ = tx.send(Err(e));
            }
            Ok((stream, rate)) => {
                let _ = tx.send(Ok(rate));
                while !thread_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
                drop(stream);
            }
        }
    });

    // 10s covers the one legitimately slow path: macOS showing the mic
    // permission prompt blocks the stream build until the user answers.
    let rate = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "Microphone initialization timed out".to_string())??;
    Ok(Recording {
        stop,
        samples,
        sample_rate: rate,
        join,
    })
}

fn push_mono(sink: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: usize, cap: usize) {
    let mut buf = sink.lock().unwrap();
    if buf.len() >= cap {
        return;
    }
    if channels <= 1 {
        buf.extend_from_slice(data);
    } else {
        for frame in data.chunks_exact(channels) {
            buf.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
}

/// Native rate → the model's 16 kHz, mono. Windowed-sinc (rubato) rather than
/// linear interpolation: 48→16 kHz without a low-pass aliases hiss into the
/// speech band, which measurably hurts ASR accuracy.
fn resample(input: Vec<f32>, from: u32) -> Result<Vec<f32>, String> {
    if from == TARGET_RATE {
        return Ok(input);
    }
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };
    const CHUNK: usize = 1024;
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::Blackman2,
    };
    let ratio = TARGET_RATE as f64 / from as f64;
    let mut rs = SincFixedIn::<f32>::new(ratio, 1.1, params, CHUNK, 1)
        .map_err(|e| format!("resampler: {e}"))?;
    let mut out = Vec::with_capacity((input.len() as f64 * ratio) as usize + CHUNK);
    let mut pos = 0;
    while input.len() - pos >= CHUNK {
        let res = rs
            .process(&[&input[pos..pos + CHUNK]], None)
            .map_err(|e| format!("resample: {e}"))?;
        out.extend_from_slice(&res[0]);
        pos += CHUNK;
    }
    if pos < input.len() {
        let res = rs
            .process_partial(Some(&[&input[pos..]]), None)
            .map_err(|e| format!("resample: {e}"))?;
        out.extend_from_slice(&res[0]);
    }
    let none: Option<&[&[f32]]> = None;
    let res = rs
        .process_partial(none, None)
        .map_err(|e| format!("resample: {e}"))?;
    out.extend_from_slice(&res[0]);
    Ok(out)
}

// ---- Tauri commands ----

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

/// The registry, with per-model install state, for the Settings page.
#[tauri::command]
pub fn dictation_models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .enumerate()
        .map(|(i, m)| ModelInfo {
            id: m.id.to_string(),
            name: m.name.to_string(),
            languages: m.languages.iter().map(|s| s.to_string()).collect(),
            size_mb: m.size_mb,
            downloaded: model_ready(m.id),
            multilingual: m.multilingual,
            is_default: i == 0,
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct DictationStatus {
    recording: bool,
    downloading: Option<String>,
    loaded: Option<String>,
}

#[tauri::command]
pub fn dictation_status(state: tauri::State<'_, DictationManager>) -> DictationStatus {
    let inner = state.0.lock().unwrap();
    DictationStatus {
        recording: inner.recording.is_some(),
        downloading: inner.downloading.clone(),
        loaded: inner.loaded_model.clone(),
    }
}

/// Kick off a background download (idempotent per model). Progress arrives as
/// dictation:progress events. Caller must hold no lock.
fn spawn_download(app: tauri::AppHandle, state: &DictationManager, def: &'static ModelDef) {
    {
        let mut inner = state.0.lock().unwrap();
        if inner.downloading.is_some() {
            return;
        }
        inner.downloading = Some(def.id.to_string());
    }
    tauri::async_runtime::spawn(async move {
        let result = download_model(app.clone(), def).await;
        let mgr = app.state::<DictationManager>();
        mgr.0.lock().unwrap().downloading = None;
        match result {
            Ok(()) => emit_progress(&app, def.id, "ready", 100.0, None),
            Err(e) => {
                log::warn!("dictation: download failed for {}: {e}", def.id);
                emit_progress(&app, def.id, "error", 0.0, Some(&e));
            }
        }
    });
}

/// Explicit setup from Settings: download a model without starting the mic.
#[tauri::command]
pub fn dictation_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationManager>,
    model_id: String,
) -> Result<(), String> {
    let def = find_def(&model_id)?;
    if !model_ready(def.id) {
        spawn_download(app, &state, def);
    }
    Ok(())
}

/// Remove a downloaded model from disk (and drop it from memory if it was the
/// loaded one). The shortcut re-downloads on next use.
#[tauri::command]
pub fn dictation_delete_model(
    state: tauri::State<'_, DictationManager>,
    model_id: String,
) -> Result<(), String> {
    let def = find_def(&model_id)?;
    let dir = model_dir(def.id)?;
    {
        let mut inner = state.0.lock().unwrap();
        if inner.recording.is_some() {
            return Err("Stop dictating before removing a model".into());
        }
        if inner.downloading.as_deref() == Some(def.id) {
            return Err("Download in progress".into());
        }
        if inner.loaded_model.as_deref() == Some(def.id) {
            inner.engine = None;
            inner.loaded_model = None;
        }
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove model: {e}"))?;
    }
    Ok(())
}

/// Begin dictation with the given model. Returns "recording" once the mic is
/// live, or "downloading" when the model isn't on disk yet — in which case the
/// download starts in the background (progress via dictation:progress).
#[tauri::command]
pub async fn dictation_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationManager>,
    model_id: String,
) -> Result<String, String> {
    let def = find_def(&model_id)?;
    {
        let inner = state.0.lock().unwrap();
        if inner.recording.is_some() {
            return Err("Already recording".into());
        }
        if inner.downloading.is_some() {
            return Ok("downloading".into());
        }
    }
    if !model_ready(def.id) {
        spawn_download(app, &state, def);
        return Ok("downloading".into());
    }
    // Load (or switch) the model off the main thread, then keep it resident.
    let need_load = {
        let inner = state.0.lock().unwrap();
        inner.loaded_model.as_deref() != Some(def.id)
    };
    if need_load {
        let engine = tauri::async_runtime::spawn_blocking(move || load_engine(def))
            .await
            .map_err(|e| e.to_string())??;
        let mut inner = state.0.lock().unwrap();
        inner.engine = Some(engine);
        inner.loaded_model = Some(def.id.to_string());
    }
    let rec = start_capture()?;
    state.0.lock().unwrap().recording = Some(rec);
    Ok("recording".into())
}

/// Stop recording and return the transcription. `language` is an optional
/// BCP-47 hint; multilingual models auto-detect and use it only as a nudge.
#[tauri::command]
pub async fn dictation_stop(
    state: tauri::State<'_, DictationManager>,
    language: Option<String>,
) -> Result<String, String> {
    let rec = state
        .0
        .lock()
        .unwrap()
        .recording
        .take()
        .ok_or("Not recording")?;
    rec.stop.store(true, Ordering::Relaxed);
    let samples = tauri::async_runtime::spawn_blocking(move || {
        let _ = rec.join.join();
        let raw = std::mem::take(&mut *rec.samples.lock().unwrap());
        // Zero frames means CoreAudio opened the stream but never called us
        // back — the macOS signature of a missing/denied mic permission (no
        // error is ever raised). Say so, instead of letting the resampler
        // choke on an empty buffer.
        if raw.is_empty() {
            return Err(
                "The microphone delivered no audio — macOS is blocking mic access. \
                 Allow it in System Settings → Privacy & Security → Microphone \
                 (for dev builds: allow the terminal app Canopy is launched from), \
                 then try again."
                    .to_string(),
            );
        }
        log::info!("dictation: {} raw frames @{} Hz", raw.len(), rec.sample_rate);
        resample(raw, rec.sample_rate)
    })
    .await
    .map_err(|e| e.to_string())??;
    if samples.len() < TARGET_RATE as usize / 4 {
        return Err("No speech captured".into());
    }
    // A denied mic permission doesn't fail on macOS — CoreAudio just streams
    // zeros. Distinguish that from real audio here, or every permission
    // problem masquerades as "No speech detected".
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    log::info!(
        "dictation: captured {:.1}s @16 kHz, peak amplitude {:.4}",
        samples.len() as f32 / TARGET_RATE as f32,
        peak
    );
    if peak < 0.004 {
        return Err(
            "Mic captured only silence — check the input device and Canopy's \
             microphone permission (System Settings → Privacy & Security → Microphone)"
                .into(),
        );
    }
    // Quiet capture devices are common; ASR accuracy drops off with low
    // signal level, so bring soft recordings up (capped, to not explode the
    // noise floor of a near-silent one).
    let samples: Vec<f32> = if peak < 0.3 {
        let gain = (0.9 / peak).min(25.0);
        samples.into_iter().map(|s| s * gain).collect()
    } else {
        samples
    };

    let (engine, loaded) = {
        let mut inner = state.0.lock().unwrap();
        (inner.engine.take(), inner.loaded_model.clone())
    };
    let mut engine = engine.ok_or("Voice model not loaded")?;
    let options = TranscribeOptions {
        language: language.filter(|l| !l.is_empty()),
        ..Default::default()
    };
    let (engine, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = engine
            .transcribe(&samples, &options)
            .map(|r| r.text)
            .map_err(|e| format!("Transcription failed: {e}"));
        (engine, result)
    })
    .await
    .map_err(|e| e.to_string())?;
    {
        let mut inner = state.0.lock().unwrap();
        // Only restore if nothing else swapped the model while we were busy.
        if inner.loaded_model == loaded {
            inner.engine = Some(engine);
        }
    }
    let text = result?.trim().to_string();
    if text.is_empty() {
        return Err("No speech detected".into());
    }
    Ok(text)
}

/// Abandon the current recording without transcribing.
#[tauri::command]
pub fn dictation_cancel(state: tauri::State<'_, DictationManager>) {
    if let Some(rec) = state.0.lock().unwrap().recording.take() {
        rec.stop.store(true, Ordering::Relaxed);
        // The capture thread notices within one 30ms tick and exits; nothing
        // to join for — the samples are dropped with the handle.
    }
}
