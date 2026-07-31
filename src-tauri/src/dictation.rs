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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::sense_voice::SenseVoiceModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::transcriber::{EnergyAdaptiveChunked, EnergyAdaptiveConfig, Transcriber};
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
    /// Longest audio this engine gets in a single inference pass. Every model
    /// has a ceiling — Moonshine refuses anything past 64s outright, SenseVoice
    /// was trained on 30s windows, and Parakeet's encoder memory grows with
    /// length — so anything longer is split into chunks of about this size.
    /// Leave headroom: an actual chunk can run to `chunk_secs + CHUNK_SEARCH_SECS
    /// + 2 * CHUNK_PADDING_SECS`.
    chunk_secs: f32,
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
        chunk_secs: 45.0,
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
        // SenseVoice was trained on 30s windows; accuracy falls off past that
        // even though nothing errors.
        chunk_secs: 25.0,
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
        // Hard 64s ceiling in the engine itself, padding included.
        chunk_secs: 45.0,
    },
];

const TARGET_RATE: u32 = 16_000;
// Bound the capture buffer: 10 minutes of speech at 48 kHz mono f32 is
// ~115 MB. Past the cap the stream keeps running but stops accumulating.
const MAX_SECONDS: u32 = 600;

// How far either side of a chunk boundary to hunt for the quietest frame, so
// splits land in a pause rather than mid-word.
const CHUNK_SEARCH_SECS: f32 = 3.0;
// Silence wrapped around every chunk. 250ms matches what Parakeet prepends on
// its own — its mel preprocessor attenuates the very start of the audio — and
// costs the other two engines nothing.
const CHUNK_PADDING_SECS: f32 = 0.25;
// Remainders below this are dropped rather than transcribed: a fifth of a
// second is a fragment of one phoneme, and Moonshine rejects anything under
// 0.1s outright.
const CHUNK_MIN_SECS: f32 = 0.2;

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

/// The loaded model, shared rather than owned, because the streaming preview
/// decodes on its own thread while the manager lock has to stay free for
/// status polls and — the one that matters — the stop that ends the recording.
/// Holding the manager lock across a half-second inference would make stop
/// wait for it.
type SharedEngine = Arc<Mutex<Option<Box<dyn SpeechModel>>>>;

#[derive(Default)]
struct Inner {
    engine: SharedEngine,
    loaded_model: Option<String>,
    recording: Option<Recording>,
    downloading: Option<String>,
    streaming: Option<StreamHandle>,
}

struct Recording {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    join: std::thread::JoinHandle<()>,
}

struct StreamHandle {
    stop: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

/// Latest input loudness, as f32 bits — written by the audio callback, read by
/// the capture thread that emits it. An atomic rather than a lock because the
/// writer is CoreAudio's realtime thread, which must never block.
#[derive(Default)]
struct LevelMeter(AtomicU32);

impl LevelMeter {
    fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
    fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
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
    model_dir(id)
        .map(|d| d.join(".complete").exists())
        .unwrap_or(false)
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

fn emit_progress(
    app: &tauri::AppHandle,
    model: &str,
    phase: &str,
    pct: f64,
    message: Option<&str>,
) {
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
    let total = resp
        .content_length()
        .unwrap_or(def.size_mb * 1_000_000)
        .max(1);
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
    tar.unpack(dest)
        .map_err(|e| format!("extract archive: {e}"))?;
    Ok(())
}

fn load_engine(def: &ModelDef) -> Result<Box<dyn SpeechModel>, String> {
    let dir = resolve_load_dir(&model_dir(def.id)?);
    let engine: Box<dyn SpeechModel> = match def.engine {
        Engine::Parakeet => {
            Box::new(ParakeetModel::load(&dir, &def.quant).map_err(|e| format!("load model: {e}"))?)
        }
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
fn start_capture(app: tauri::AppHandle) -> Result<Recording, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    let thread_stop = stop.clone();
    let thread_samples = samples.clone();
    let thread_meter = Arc::new(LevelMeter::default());

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
                    let m = thread_meter.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &_| push_mono(&sink, data, channels, cap, &m),
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let sink = thread_samples.clone();
                    let m = thread_meter.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &_| {
                            let f: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                            push_mono(&sink, &f, channels, cap, &m);
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let sink = thread_samples.clone();
                    let m = thread_meter.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[u16], _: &_| {
                            let f: Vec<f32> =
                                data.iter().map(|s| *s as f32 / 32768.0 - 1.0).collect();
                            push_mono(&sink, &f, channels, cap, &m);
                        },
                        err_fn,
                        None,
                    )
                }
                other => return Err(format!("Unsupported microphone format: {other:?}")),
            }
            .map_err(|e| format!("Could not open microphone: {e}"))?;
            stream
                .play()
                .map_err(|e| format!("Could not start microphone: {e}"))?;
            Ok((stream, rate))
        };
        match open() {
            Err(e) => {
                let _ = tx.send(Err(e));
            }
            Ok((stream, rate)) => {
                let _ = tx.send(Ok(rate));
                // This thread exists only to own the (non-Send) cpal stream and
                // notice the stop flag, so it is also the right place to publish
                // the meter: it already ticks at 30ms, and unlike the audio
                // callback it is allowed to allocate and cross into Tauri's IPC.
                while !thread_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(33));
                    let _ = app.emit("dictation:level", thread_meter.get());
                }
                drop(stream);
            }
        }
    });

    // 10s covers the one legitimately slow path: macOS showing the mic
    // permission prompt blocks the stream build until the user answers.
    let rate = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(res) => res?,
        Err(_) => {
            // Signal the capture thread to stop so that, once its blocked
            // stream build finally returns (e.g. a late permission answer), it
            // tears the stream down and exits instead of holding the mic open
            // forever on an orphaned thread.
            stop.store(true, Ordering::Relaxed);
            return Err("Microphone initialization timed out".to_string());
        }
    };
    Ok(Recording {
        stop,
        samples,
        sample_rate: rate,
        join,
    })
}

fn push_mono(
    sink: &Arc<Mutex<Vec<f32>>>,
    data: &[f32],
    channels: usize,
    cap: usize,
    meter: &LevelMeter,
) {
    // Metered before the cap check, so the visualiser keeps responding even
    // once a very long recording has stopped accumulating.
    if !data.is_empty() {
        let sum_sq: f32 = data.iter().map(|s| s * s).sum();
        meter.set((sum_sq / data.len() as f32).sqrt());
    }
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

// ---- Streaming preview ----
//
// A second decode loop that runs while you speak, purely so the pill can show
// words appearing. It is NOT the path the final text comes from: dictation_stop
// still decodes the whole recording once, cleanly, and that is what gets
// inserted. Keeping the preview off the critical path is what lets it take the
// cheap shortcuts below without costing any accuracy.
//
// The shortcut that matters: each pass re-decodes only the last
// STREAM_WINDOW_SECS of audio, so cost is flat no matter how long you talk.
// Text that scrolls out of that window is gone from the preview — which is
// fine, because the preview is a marquee of what you just said, and the full
// text arrives at the end regardless.

/// How much trailing audio each preview pass decodes. Long enough for the
/// model to have real context, short enough that a pass stays well under a
/// second on CPU.
const STREAM_WINDOW_SECS: f32 = 12.0;
/// Below this there is not enough audio for a useful hypothesis.
const STREAM_MIN_SECS: f32 = 0.8;
/// Floor on the gap between passes. The real gap is whichever is longer, this
/// or the time the last decode took, so a slow machine backs itself off
/// instead of queueing work it cannot keep up with.
const STREAM_MIN_INTERVAL_MS: u64 = 400;

/// How many leading words two hypotheses agree on.
fn common_prefix_len(a: &[String], b: &[String]) -> usize {
    a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

/// Re-decode the trailing window until told to stop, emitting `dictation:partial`.
///
/// Successive passes disagree about the last few words — the model revises its
/// guess as more audio arrives — and rendering that raw makes the text flicker
/// and rewrite itself. So each hypothesis is split at the point where it stops
/// agreeing with the previous one: the agreed prefix is "confirmed" and stays
/// put, the tail is "unconfirmed" and is drawn dimmed. This is the
/// LocalAgreement rule from the whisper-streaming literature, and it is the
/// difference between a preview that reads and one that twitches.
fn spawn_streaming(
    app: tauri::AppHandle,
    engine: SharedEngine,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    language: Option<String>,
) -> StreamHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let join = std::thread::spawn(move || {
        let window = (STREAM_WINDOW_SECS * sample_rate as f32) as usize;
        let min_samples = (STREAM_MIN_SECS * sample_rate as f32) as usize;
        let mut prev: Vec<String> = Vec::new();
        let mut interval = STREAM_MIN_INTERVAL_MS;

        loop {
            // Sleep in short slices so stop is noticed promptly rather than
            // after a whole interval.
            let mut slept = 0;
            while slept < interval {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
                slept += 25;
            }

            // Copy the tail and get out of the lock immediately — the audio
            // callback contends for this same mutex and must never wait.
            let tail: Vec<f32> = {
                let buf = samples.lock().unwrap();
                if buf.len() < min_samples {
                    continue;
                }
                buf[buf.len().saturating_sub(window)..].to_vec()
            };

            let started = std::time::Instant::now();
            let resampled = match resample(tail, sample_rate) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("dictation: streaming resample failed: {e}");
                    continue;
                }
            };
            let options = TranscribeOptions {
                language: language.clone().filter(|l| !l.is_empty()),
                ..Default::default()
            };
            let text = {
                let mut guard = engine.lock().unwrap();
                let Some(model) = guard.as_mut() else {
                    return;
                };
                match model.transcribe(&resampled, &options) {
                    Ok(r) => r.text,
                    Err(e) => {
                        log::warn!("dictation: streaming pass failed: {e}");
                        continue;
                    }
                }
            };
            if thread_stop.load(Ordering::Relaxed) {
                return;
            }

            let words: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();
            let agreed = common_prefix_len(&prev, &words);
            let _ = app.emit(
                "dictation:partial",
                serde_json::json!({
                    "confirmed": words[..agreed].join(" "),
                    "unconfirmed": words[agreed..].join(" "),
                }),
            );
            prev = words;

            let elapsed = started.elapsed().as_millis() as u64;
            interval = elapsed.max(STREAM_MIN_INTERVAL_MS);
        }
    });
    StreamHandle { stop, join }
}

/// Stop the preview loop and wait for its in-flight decode to finish, so the
/// engine lock is free before the caller reaches for it. Must be called with
/// no manager lock held — the worker can be mid-inference for a few hundred ms.
fn halt_streaming(handle: Option<StreamHandle>) {
    if let Some(h) = handle {
        h.stop.store(true, Ordering::Relaxed);
        let _ = h.join.join();
    }
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
            *inner.engine.lock().unwrap() = None;
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
    streaming: Option<bool>,
    language: Option<String>,
    mute_output: Option<bool>,
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
        // Loading a multi-hundred-MB ONNX model is the one genuinely slow step
        // on the start path, and — unlike the mic, which is capped at 10s — it
        // had no time bound. A wedged load (corrupt files that still passed the
        // .complete check, an ONNX session init that never returns) therefore
        // left the UI stuck on "Starting dictation…" forever, with no way out.
        // Announce the load so the pill can say so on first use, and cap the
        // wait so a stuck load surfaces as an error instead of hanging.
        emit_progress(&app, def.id, "load", 0.0, None);
        let load = tauri::async_runtime::spawn_blocking(move || load_engine(def));
        let engine = match tokio::time::timeout(std::time::Duration::from_secs(90), load).await {
            Ok(joined) => joined.map_err(|e| e.to_string())??,
            // The blocking load can't be cancelled, so it runs on to completion
            // and is dropped; the user gets an actionable error either way.
            Err(_) => {
                return Err(
                    "Loading the voice model timed out — the model files may be corrupt. \
                     Remove and re-download the model in Settings → Dictation."
                        .into(),
                );
            }
        };
        let mut inner = state.0.lock().unwrap();
        *inner.engine.lock().unwrap() = Some(engine);
        inner.loaded_model = Some(def.id.to_string());
    }
    // Only after the model is resident: muting during a 30s first-use download
    // would leave the speakers off for the whole wait.
    if mute_output.unwrap_or(false) {
        crate::sysaudio::mute();
    }
    let rec = match start_capture(app.clone()) {
        Ok(rec) => rec,
        Err(e) => {
            // A mic that never opened must not leave the speakers muted.
            crate::sysaudio::restore();
            return Err(e);
        }
    };
    let (engine, samples, rate) = {
        let mut inner = state.0.lock().unwrap();
        let shared = (inner.engine.clone(), rec.samples.clone(), rec.sample_rate);
        inner.recording = Some(rec);
        shared
    };
    if streaming.unwrap_or(false) {
        let handle = spawn_streaming(app, engine, samples, rate, language);
        state.0.lock().unwrap().streaming = Some(handle);
    }
    Ok("recording".into())
}

/// Feed the audio through the model in bounded chunks, split at the quietest
/// frame near each boundary so a cut lands in a pause rather than mid-word.
/// Every engine has a length ceiling — Moonshine rejects anything past 64s
/// outright, the others silently get worse — so long dictation is transcribed
/// piecewise and the texts merged.
///
/// Audio short enough for a single pass goes through the same path as one
/// chunk, so there is only one route to keep working.
fn transcribe_chunked(
    engine: &mut dyn SpeechModel,
    chunk_secs: f32,
    config: EnergyAdaptiveConfig,
    options: TranscribeOptions,
    samples: &[f32],
    on_progress: &dyn Fn(f64),
) -> Result<String, String> {
    let fail = |e| format!("Transcription failed: {e}");
    let total = samples.len();
    let step = ((chunk_secs * TARGET_RATE as f32) as usize).max(1);
    let mut chunker = EnergyAdaptiveChunked::new(config, options);
    // Minutes of CPU inference behind a motionless "Transcribing…" reads as a
    // hang, so hand over one chunk's worth at a time and report the chunks that
    // come back. Short dictation completes in one pass and stays silent.
    let expected = total.div_ceil(step).max(1);
    let mut done = 0usize;
    let mut fed = 0usize;
    while fed < total {
        let end = (fed + step).min(total);
        done += chunker
            .feed(engine, &samples[fed..end])
            .map_err(fail)?
            .len();
        fed = end;
        if expected > 1 {
            // Never 100%: finish() still has the tail of the buffer to run.
            on_progress((done as f64 / expected as f64 * 100.0).min(99.0));
        }
    }
    chunker.finish(engine).map(|r| r.text).map_err(fail)
}

/// The chunking setup for a model: how long a piece it can take, and how the
/// pieces are joined back together.
fn chunk_config(def: &ModelDef, language: Option<&str>) -> EnergyAdaptiveConfig {
    // Chunk texts are joined with a space — except for CJK, which is written
    // without word separators. Take the cue from the language hint, falling
    // back to the model's primary language (SenseVoice is the CJK one).
    let lang = language.unwrap_or(def.languages[0]);
    let cjk = matches!(
        lang.split(['-', '_']).next().unwrap_or(lang),
        "zh" | "yue" | "ja" | "ko" | "th"
    );
    EnergyAdaptiveConfig {
        target_chunk_secs: def.chunk_secs,
        search_window_secs: CHUNK_SEARCH_SECS,
        padding_secs: CHUNK_PADDING_SECS,
        min_chunk_secs: CHUNK_MIN_SECS,
        merge_separator: if cjk { "" } else { " " }.to_string(),
        ..Default::default()
    }
}

/// Stop recording and return the transcription. `language` is an optional
/// BCP-47 hint; multilingual models auto-detect and use it only as a nudge.
#[tauri::command]
pub async fn dictation_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationManager>,
    language: Option<String>,
) -> Result<String, String> {
    // Speakers come back the moment the mic closes, not after transcription —
    // the decode can take seconds and there is nothing to protect by then.
    crate::sysaudio::restore();
    // End the preview loop before touching the engine: it can be mid-decode,
    // and the final pass needs the same lock.
    let streaming = state.0.lock().unwrap().streaming.take();
    halt_streaming(streaming);
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
        log::info!(
            "dictation: {} raw frames @{} Hz",
            raw.len(),
            rec.sample_rate
        );
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

    // The authoritative decode: the whole recording, with full context, in
    // pieces no longer than the engine can take in one pass. Whatever the
    // streaming preview showed has no bearing on it.
    let (engine, loaded) = {
        let inner = state.0.lock().unwrap();
        (inner.engine.clone(), inner.loaded_model.clone())
    };
    let def = find_def(loaded.as_deref().unwrap_or(""))?;
    let language = language.filter(|l| !l.is_empty());
    let config = chunk_config(def, language.as_deref());
    let options = TranscribeOptions {
        language,
        ..Default::default()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = engine.lock().unwrap();
        let model = guard.as_mut().ok_or("Voice model not loaded")?;
        transcribe_chunked(
            &mut **model,
            def.chunk_secs,
            config,
            options,
            &samples,
            &|pct| emit_progress(&app, def.id, "transcribe", pct, None),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let text = result?.trim().to_string();
    if text.is_empty() {
        return Err("No speech detected".into());
    }
    Ok(text)
}

/// Abandon the current recording without transcribing.
#[tauri::command]
pub fn dictation_cancel(state: tauri::State<'_, DictationManager>) {
    crate::sysaudio::restore();
    let streaming = state.0.lock().unwrap().streaming.take();
    halt_streaming(streaming);
    if let Some(rec) = state.0.lock().unwrap().recording.take() {
        rec.stop.store(true, Ordering::Relaxed);
        // The capture thread notices within one 30ms tick and exits; nothing
        // to join for — the samples are dropped with the handle.
    }
}

/// Whether this build can run dictation. Reaching this compile unit means the
/// `dictation` feature is on, so the answer is yes; builds without it use the
/// stub in dictation_stub.rs, which returns false (and the UI hides dictation).
#[tauri::command]
pub fn dictation_supported() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chunk runs to its target plus the split-search window plus padding on
    /// both sides, and that worst case is what the engine actually sees.
    /// Moonshine hard-errors past 64s ("Audio duration must be between 0.1s and
    /// 64s"), which is how long dictation used to fail outright — so every
    /// model's worst case has to stay well under it.
    #[test]
    fn worst_case_chunk_stays_under_the_engine_ceiling() {
        for m in MODELS {
            let worst = m.chunk_secs + CHUNK_SEARCH_SECS + 2.0 * CHUNK_PADDING_SECS;
            assert!(worst <= 60.0, "{}: worst-case chunk is {worst}s", m.id);
        }
    }

    /// The streaming preview decodes a rolling window rather than the whole
    /// recording, which is why it never hit the ceiling the final pass did.
    /// It only stays that way while the window is the shorter of the two.
    #[test]
    fn streaming_window_needs_no_chunking() {
        for m in MODELS {
            assert!(
                STREAM_WINDOW_SECS <= m.chunk_secs,
                "{}: preview window {STREAM_WINDOW_SECS}s exceeds one pass",
                m.id
            );
        }
    }

    /// CJK is written without spaces between words, so chunk texts must not be
    /// rejoined with one.
    #[test]
    fn chunk_texts_join_without_a_space_for_cjk() {
        let sensevoice = find_def("sensevoice").unwrap();
        let parakeet = find_def("parakeet-v3").unwrap();
        // No hint: the model's own primary language decides.
        assert_eq!(chunk_config(sensevoice, None).merge_separator, "");
        assert_eq!(chunk_config(parakeet, None).merge_separator, " ");
        // An explicit hint wins, region subtag and all.
        assert_eq!(chunk_config(sensevoice, Some("en")).merge_separator, " ");
        assert_eq!(chunk_config(parakeet, Some("ja-JP")).merge_separator, "");
    }

    /// The reported failure, end to end: 74s of audio through Moonshine, which
    /// refuses anything past 64s in a single pass. Needs the model on disk, so
    /// it is ignored by default — run with
    /// `cargo test --features dictation -- --ignored long_audio`.
    #[test]
    #[ignore = "requires a downloaded model"]
    fn long_audio_transcribes_instead_of_erroring() {
        for def in MODELS {
            if !model_ready(def.id) {
                eprintln!("skipping {} — not downloaded", def.id);
                continue;
            }
            let mut engine = load_engine(def).expect("load model");
            // 74.07s, the length from the bug report. Content doesn't matter —
            // the length check fires before any inference — so this is a tone
            // with pauses punched in, which also gives the splitter somewhere
            // sensible to cut.
            let n = (74.07 * TARGET_RATE as f32) as usize;
            let samples: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / TARGET_RATE as f32;
                    if t % 5.0 < 0.4 {
                        0.0
                    } else {
                        0.2 * (t * 220.0 * std::f32::consts::TAU).sin()
                    }
                })
                .collect();
            let reported = std::cell::RefCell::new(Vec::new());
            let result = transcribe_chunked(
                &mut *engine,
                def.chunk_secs,
                chunk_config(def, None),
                TranscribeOptions::default(),
                &samples,
                &|pct| reported.borrow_mut().push(pct),
            );
            assert!(result.is_ok(), "{}: {:?}", def.id, result.err());
            assert!(
                !reported.borrow().is_empty(),
                "{}: no progress reported",
                def.id
            );
        }
    }
}
