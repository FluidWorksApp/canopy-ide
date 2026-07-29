// Silence the speakers while the mic is open, so what is playing does not end
// up in the transcript — and so dictating over a video does not mean talking
// over it.
//
// This mutes the default OUTPUT DEVICE. It does not pause anything: there is
// no way to tell another app's player to stop that does not involve either
// posting system-wide media keys (Accessibility permission, and a toggle whose
// meaning depends on state we cannot read) or per-app scripting. Muting the
// device needs no permission and no entitlement — it is a plain CoreAudio HAL
// property write — and it is what SuprFlow's SystemAudioService does.
//
// Two strategies, in order, because not every device implements mute:
// built-in speakers usually do; Bluetooth, AirPods, HDMI and many USB
// interfaces do not, and those fall back to setting the volume to zero.
//
// The risk worth naming: if the process dies while muted, the speakers stay
// muted until something turns them back up. Hardware mute is preferred partly
// for that reason — a volume key press undoes it — and restore() is wired to
// stop, cancel, error and app exit.
// Unused on two axes: off macOS nothing is implemented, and with the dictation
// feature compiled out nothing ever mutes (restore() is still called on exit,
// where it is a no-op).
#![cfg_attr(
    any(not(target_os = "macos"), not(feature = "dictation")),
    allow(dead_code)
)]

use std::sync::Mutex;

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Mutex;

    type OSStatus = i32;
    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    }

    const SYSTEM_OBJECT: AudioObjectID = 1;
    const UNKNOWN_DEVICE: AudioObjectID = 0;
    /// Four-character codes, as CoreAudio spells them.
    const DEFAULT_OUTPUT_DEVICE: u32 = u32::from_be_bytes(*b"dOut");
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const SCOPE_OUTPUT: u32 = u32::from_be_bytes(*b"outp");
    const PROP_MUTE: u32 = u32::from_be_bytes(*b"mute");
    const PROP_VOLUME: u32 = u32::from_be_bytes(*b"volm");
    const ELEMENT_MAIN: u32 = 0;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            data_size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            data_size: u32,
            data: *const std::ffi::c_void,
        ) -> OSStatus;
        fn AudioObjectHasProperty(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
        ) -> u8;
        fn AudioObjectIsPropertySettable(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            settable: *mut u8,
        ) -> OSStatus;
    }

    fn addr(selector: u32, scope: u32, element: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector,
            scope,
            element,
        }
    }

    fn default_output() -> AudioObjectID {
        let a = addr(DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL, ELEMENT_MAIN);
        let mut id: AudioObjectID = UNKNOWN_DEVICE;
        let mut size = std::mem::size_of::<AudioObjectID>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut id as *mut _ as *mut _,
            )
        };
        if status == 0 {
            id
        } else {
            UNKNOWN_DEVICE
        }
    }

    fn settable(device: AudioObjectID, selector: u32, element: u32) -> bool {
        let a = addr(selector, SCOPE_OUTPUT, element);
        if unsafe { AudioObjectHasProperty(device, &a) } == 0 {
            return false;
        }
        let mut yes: u8 = 0;
        unsafe { AudioObjectIsPropertySettable(device, &a, &mut yes) == 0 && yes != 0 }
    }

    fn get_u32(device: AudioObjectID, selector: u32, element: u32) -> Option<u32> {
        let a = addr(selector, SCOPE_OUTPUT, element);
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut v as *mut _ as *mut _,
            )
        };
        (status == 0).then_some(v)
    }

    fn set_u32(device: AudioObjectID, selector: u32, element: u32, v: u32) -> bool {
        let a = addr(selector, SCOPE_OUTPUT, element);
        unsafe {
            AudioObjectSetPropertyData(
                device,
                &a,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                &v as *const _ as *const _,
            ) == 0
        }
    }

    fn get_f32(device: AudioObjectID, selector: u32, element: u32) -> Option<f32> {
        let a = addr(selector, SCOPE_OUTPUT, element);
        let mut v: f32 = 0.0;
        let mut size = std::mem::size_of::<f32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut v as *mut _ as *mut _,
            )
        };
        (status == 0).then_some(v)
    }

    fn set_f32(device: AudioObjectID, selector: u32, element: u32, v: f32) -> bool {
        let a = addr(selector, SCOPE_OUTPUT, element);
        unsafe {
            AudioObjectSetPropertyData(
                device,
                &a,
                0,
                std::ptr::null(),
                std::mem::size_of::<f32>() as u32,
                &v as *const _ as *const _,
            ) == 0
        }
    }

    /// What we changed, and how to put it back.
    pub enum Saved {
        /// Device had a real mute switch; we flipped it.
        Mute { device: AudioObjectID },
        /// No mute switch, so we zeroed these channels' volumes.
        Volume {
            device: AudioObjectID,
            levels: Vec<(u32, f32)>,
        },
    }

    pub static STATE: Mutex<Option<Saved>> = Mutex::new(None);

    pub fn mute() {
        let mut guard = STATE.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let device = default_output();
        if device == UNKNOWN_DEVICE {
            return;
        }

        if settable(device, PROP_MUTE, ELEMENT_MAIN) {
            // Already muted by the user? Leave it, and record nothing, so we
            // never "restore" them to unmuted audio they had switched off.
            if get_u32(device, PROP_MUTE, ELEMENT_MAIN).unwrap_or(0) != 0 {
                return;
            }
            if set_u32(device, PROP_MUTE, ELEMENT_MAIN, 1) {
                *guard = Some(Saved::Mute { device });
            }
            return;
        }

        // Main volume, else per-channel (element 1/2 = L/R).
        let mut levels = Vec::new();
        if settable(device, PROP_VOLUME, ELEMENT_MAIN) {
            if let Some(v) = get_f32(device, PROP_VOLUME, ELEMENT_MAIN) {
                if set_f32(device, PROP_VOLUME, ELEMENT_MAIN, 0.0) {
                    levels.push((ELEMENT_MAIN, v));
                }
            }
        } else {
            for ch in 1..=2u32 {
                if settable(device, PROP_VOLUME, ch) {
                    if let Some(v) = get_f32(device, PROP_VOLUME, ch) {
                        if set_f32(device, PROP_VOLUME, ch, 0.0) {
                            levels.push((ch, v));
                        }
                    }
                }
            }
        }
        if levels.is_empty() {
            log::warn!("dictation: output device supports neither mute nor volume");
        } else {
            *guard = Some(Saved::Volume { device, levels });
        }
    }

    pub fn restore() {
        let Some(saved) = STATE.lock().unwrap().take() else {
            return;
        };
        match saved {
            Saved::Mute { device } => {
                set_u32(device, PROP_MUTE, ELEMENT_MAIN, 0);
            }
            Saved::Volume { device, levels } => {
                for (element, v) in levels {
                    set_f32(device, PROP_VOLUME, element, v);
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    // Windows would want IAudioEndpointVolume (WASAPI) and Linux the
    // PulseAudio/PipeWire sink volume. Neither is wired up, so the setting has
    // no effect there rather than pretending to work.
    pub fn mute() {}
    pub fn restore() {}
}

/// Guards against a restore that arrives with no matching mute — cheap enough
/// to keep the callers from having to track whether they muted.
static ARMED: Mutex<bool> = Mutex::new(false);

/// Silence the default output device. No-op if already silenced by us, if the
/// user had already muted it, or on a platform this is not implemented for.
pub fn mute() {
    let mut armed = ARMED.lock().unwrap();
    if *armed {
        return;
    }
    *armed = true;
    imp::mute();
}

/// Put the output device back exactly as we found it. Safe to call when we
/// never muted, and safe to call twice.
pub fn restore() {
    let mut armed = ARMED.lock().unwrap();
    if !*armed {
        return;
    }
    *armed = false;
    imp::restore();
}
