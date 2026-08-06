# Third-party notices

Canopy is licensed under the MIT License (see [LICENSE.md](./LICENSE.md)). The
components listed here are licensed by their respective authors under the terms
below, and those terms — not Canopy's — govern their use.

This file is generated. Do not edit it by hand:

    node scripts/generate-third-party-notices.mjs

It covers what Canopy **distributes**: the Rust dependency closure of the app
binary (dev-only crates pruned), the production npm closure that is bundled into
the frontend, and the prebuilt binaries shipped inside the app bundle. Build-only
tooling — Vite, Rolldown, oxlint, TypeScript, lightningcss and friends — is not
listed, because it never leaves the build machine. Hand-ported source is
listed too, under "Notes on specific components", since it appears in no
manifest.

Each component appears with the copyright notice taken from its own license
file; the full text of every license in play is reproduced in the appendix.

## Notes on specific components

**fzf — MIT.** `shared/fuzzy.ts` is a hand port of fzf's matching and scoring
algorithm (`algo/algo.go`), compiled into the frontend bundle. Copyright (c)
2013-2026 Junegunn Choi; MIT text in the appendix; source:
<https://github.com/junegunn/fzf>.

**jschardet 3.1.4 — LGPL-2.1-or-later.** Pulled in transitively by
`@codingame/monaco-vscode-api` for character-set detection, and included in the
distributed application. The LGPL permits this without affecting Canopy's own
license, provided users can replace the library with a modified version. Canopy
ships jschardet as its own separate JavaScript chunk (`assets/jschardet-*.js`)
rather than inlining it into the main bundle, so it can be substituted in place.
Its full text is in the appendix below; source:
<https://github.com/aadsm/jschardet>.

**Dual-licensed components.** Where a component offers a choice, Canopy elects
the permissive option and only that option's terms bind this distribution —
`jszip` under MIT (not GPL-3.0-or-later), `dompurify` under Apache-2.0 (not
MPL-2.0), `r-efi` under MIT (not LGPL-2.1-or-later), and the large
MIT-or-Apache-2.0 Rust ecosystem under MIT. Components are grouped below by the
elected license, not the declared expression.

**Bundled fonts — OFL-1.1.** Archivo and JetBrains Mono ship inside the app as
`.woff2` files (the Vitrine skin sets them; every other skin uses the system
UI font). The OFL exists to permit exactly this: it allows the fonts to be
bundled and redistributed with software, including commercially, and it does
not reach the software they ship with — Canopy stays MIT. What it does require
is met here. The fonts are not sold on their own. Each holder's copyright
notice is reproduced above and the license text in full below. Neither family
declares a Reserved Font Name, so the subsetting the `@fontsource-variable`
packages perform to produce the `.woff2` files does not oblige a rename.

**MPL-2.0 components** are file-level copyleft: obligations attach only to
modifications of those files, which Canopy does not make. Their sources are
available from their upstream repositories at the versions listed.

**PDF preview** uses the host webview's built-in PDF viewer via an `<embed>`
element (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). No PDF
rendering library is bundled, so nothing is redistributed for that feature.

## Prebuilt binaries shipped in the app bundle

**ONNX Runtime 1.24.x — MIT.** Copyright (c) Microsoft Corporation. Microsoft's official prebuilt shared library (`libonnxruntime.dylib` / `.so` / `.dll`), fetched at release time and shipped in the app bundle as `onnxruntime/`. Voice dictation loads it dynamically. The Intel-macOS build has no compatible release and ships without it. <https://github.com/microsoft/onnxruntime>

## Models downloaded at runtime

Voice dictation downloads a speech model on first use. Canopy does not
redistribute these — they are fetched to the user's own machine — but their
terms govern use of the model:

- **Parakeet TDT 0.6B v3 (int8)** — CC-BY-4.0, by NVIDIA. <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- **SenseVoice Small (int8)** — FunASR MODEL_LICENSE (custom) — <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>, by FunAudioLLM / Alibaba. <https://huggingface.co/FunAudioLLM/SenseVoiceSmall>
- **Moonshine Base** — MIT, by Useful Sensors. <https://huggingface.co/UsefulSensors/moonshine>

## Rust crates (718)

### MIT — 659

- **adler2 2.0.1** — Copyright (C) Jonas Schievink <jonasschievink@gmail.com>
- **aead 0.5.2** — Copyright (c) 2019 The RustCrypto Project Developers; Copyright (c) 2019 MobileCoin, LLC
- **aes 0.9.2** — Copyright (c) 2018-2024 The RustCrypto Project Developers; Copyright (c) 2018 Artyom Pavlov
- **ahash 0.8.12** — Copyright (c) 2018 Tom Kaitchuck
- **aho-corasick 1.1.4** — Copyright (c) 2015 Andrew Gallant
- **alsa 0.9.1** — Copyright (c) 2015-2021 David Henningsson, and other contributors
- **alsa-sys 0.3.1** — Copyright (c) 2018 diwic
- **android_log-sys 0.3.2** — Copyright (c) 2016 The android_log_sys Developers
- **android_logger 0.15.1** — Copyright (c) 2016 The android_logger Developers
- **android_system_properties 0.1.5** — Copyright 2016 Nicolas Silva
- **anyhow 1.0.103** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **arbitrary 1.4.2** — Copyright (c) 2019 Manish Goregaokar
- **argon2 0.5.3** — Copyright (c) 2021-2024 The RustCrypto Project Developers
- **arrayvec 0.7.8** — Copyright (c) Ulrik Sverdrup "bluss" 2015-2023
- **async-broadcast 0.7.2** — Copyright (c) 2020 Yoshua Wuyts
- **async-channel 2.5.0** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **async-executor 1.14.0** — Copyright Stjepan Glavina, John Nunley (per package manifest; the distributed license file carries no copyright line)
- **async-io 2.6.0** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **async-lock 3.4.2** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **async-process 2.5.0** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **async-recursion 1.1.1** — Copyright Robert Usher (per package manifest; the distributed license file carries no copyright line)
- **async-signal 0.2.14** — Copyright John Nunley (per package manifest; the distributed license file carries no copyright line)
- **async-task 4.7.1** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **async-trait 0.1.91** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **atk 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **atk-sys 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **atomic-waker 1.1.2** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **autocfg 1.5.1** — Copyright (c) 2018 Josh Stone
- **axum 0.7.9** — Copyright (c) 2019 Axum Contributors
- **axum-core 0.4.5** — Copyright 2021 Axum Contributors
- **base64 0.21.7** — Copyright (c) 2015 Alice Maz
- **base64 0.22.1** — Copyright (c) 2015 Alice Maz
- **base64ct 1.8.3** — Copyright (c) 2014 Steve "Sc00bz" Thomas (steve at tobtu dot com); Copyright (c) 2021-2025 The RustCrypto Project Developers
- **bit-set 0.8.0** — Copyright (c) 2023 The Rust Project Developers
- **bit-vec 0.8.0** — Copyright (c) 2023 The Rust Project Developers
- **bitflags 1.3.2** — Copyright (c) 2014 The Rust Project Developers
- **bitflags 2.13.1** — Copyright (c) 2014 The Rust Project Developers
- **blake2 0.10.6** — Copyright (c) 2015-2016 The blake2-rfc Developers, Cesar Barros; Copyright (c) 2017 Artyom Pavlov
- **blake2b_simd 1.0.4** — Copyright Jack O'Connor (per package manifest; the distributed license file carries no copyright line)
- **block-buffer 0.10.4** — Copyright (c) 2018-2019 The RustCrypto Project Developers
- **block-buffer 0.12.1** — Copyright (c) 2018-2025 The RustCrypto Project Developers
- **block-modes 0.9.1** — Copyright RustCrypto Developers (per package manifest; the distributed license file carries no copyright line)
- **block-padding 0.4.2** — Copyright (c) 2018-2025 The RustCrypto Project Developers
- **block2 0.6.2** — Copyright Mads Marquart (per package manifest; the distributed license file carries no copyright line)
- **blocking 1.6.2** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **brotli-decompressor 5.0.3** — Copyright (c) 2016 Dropbox, Inc
- **bs58 0.5.1** — Copyright (c) 2016 The roaring-rs developers
- **bstr 1.13.0** — Copyright (c) 2018-2019 Andrew Gallant
- **bumpalo 3.20.3** — Copyright (c) 2019 Nick Fitzgerald
- **bytemuck 1.25.1** — Copyright (c) 2019 Daniel "Lokathor" Gee
- **byteorder 1.5.0** — Copyright (c) 2015 Andrew Gallant
- **byteorder-lite 0.1.0** — Copyright (c) 2015 Andrew Gallant
- **bytes 1.12.1** — Copyright (c) 2018 Carl Lerche
- **cairo-rs 0.18.5** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **cairo-sys-rs 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **camino 1.2.4** — Copyright Without Boats, Ashley Williams, Steve Klabnik, Rain (per package manifest; the distributed license file carries no copyright line)
- **cargo_metadata 0.19.2** — Copyright Oliver Schneider (per package manifest; the distributed license file carries no copyright line)
- **cargo_toml 0.22.3** — Copyright Kornel (per package manifest; the distributed license file carries no copyright line)
- **cargo-platform 0.1.9** — no copyright line in the distributed license file
- **cbc 0.2.1** — Copyright (c) 2018-2022 RustCrypto Developers; Copyright (c) 2018 Artyom Pavlov
- **cc 1.2.67** — Copyright (c) 2014 Alex Crichton
- **cesu8 1.1.0** — Copyright (C) 2000-2010 Julian Seward. All rights
- **cfb 0.7.3** — Copyright (c) 2017 Matthew D. Steele
- **cfg_aliases 0.1.1** — Copyright (c) 2020 Katharos Technology
- **cfg_aliases 0.2.2** — Copyright (c) 2020 Katharos Technology
- **cfg-expr 0.15.8** — Copyright (c) 2019 Embark Studios
- **cfg-if 1.0.4** — Copyright (c) 2014 Alex Crichton
- **chacha20 0.10.1** — Copyright (c) 2019-2026 The RustCrypto Project Developers
- **chacha20 0.9.1** — Copyright (c) 2019-2023 The RustCrypto Project Developers
- **chacha20poly1305 0.10.1** — Copyright (c) 2019 The RustCrypto Project Developers
- **chrono 0.4.45** — Copyright (c) 2014, Kang Seonghoon
- **cipher 0.4.4** — Copyright (c) 2016-2020 RustCrypto Developers
- **cipher 0.5.2** — Copyright (c) 2016-2025 RustCrypto Developers
- **cmov 0.5.4** — Copyright (c) 2022-2026 The RustCrypto Project Developers
- **combine 4.6.7** — Copyright (c) 2015 Markus Westerlind
- **concurrent-queue 2.5.0** — Copyright Stjepan Glavina, Taiki Endo, John Nunley (per package manifest; the distributed license file carries no copyright line)
- **const-oid 0.10.2** — Copyright (c) 2020-2026 The RustCrypto Project Developers
- **const-oid 0.9.6** — Copyright (c) 2020-2022 The RustCrypto Project Developers
- **cookie 0.18.1** — Copyright (c) 2017 Sergio Benitez; Copyright (c) 2014 Alex Crichton
- **core-foundation 0.10.1** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **core-foundation-sys 0.8.7** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **core-graphics 0.25.0** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **core-graphics-types 0.2.0** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **coreaudio-rs 0.13.0** — Copyright (c) 2015
- **cpubits 0.1.1** — Copyright (c) 2023-2026 The RustCrypto Project Developers
- **cpufeatures 0.2.17** — Copyright (c) 2020-2025 The RustCrypto Project Developers
- **cpufeatures 0.3.0** — Copyright (c) 2020-2025 The RustCrypto Project Developers
- **crc32fast 1.5.0** — Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors
- **crossbeam-channel 0.5.16** — Copyright (c) 2019 The Crossbeam Project Developers
- **crossbeam-deque 0.8.7** — Copyright (c) 2019 The Crossbeam Project Developers
- **crossbeam-epoch 0.9.20** — Copyright (c) 2019 The Crossbeam Project Developers
- **crossbeam-utils 0.8.22** — Copyright (c) 2019 The Crossbeam Project Developers
- **crypto-common 0.1.7** — Copyright (c) 2021 RustCrypto Developers
- **crypto-common 0.2.2** — Copyright (c) 2021-2026 RustCrypto Developers
- **ctor 0.8.0** — Copyright Matt Mastracci (per package manifest; the distributed license file carries no copyright line)
- **ctor-proc-macro 0.0.7** — Copyright Matt Mastracci (per package manifest; the distributed license file carries no copyright line)
- **ctutils 0.4.2** — Copyright (c) 2025-2026 The RustCrypto Project Developers
- **curve25519-dalek-derive 0.1.1** — no copyright line in the distributed license file
- **darling 0.20.11** — Copyright (c) 2017 Ted Driggs
- **darling 0.23.0** — Copyright (c) 2017 Ted Driggs
- **darling_core 0.20.11** — Copyright (c) 2017 Ted Driggs
- **darling_core 0.23.0** — Copyright (c) 2017 Ted Driggs
- **darling_macro 0.20.11** — Copyright (c) 2017 Ted Driggs
- **darling_macro 0.23.0** — Copyright (c) 2017 Ted Driggs
- **dasp_sample 0.11.0** — Copyright mitchmindtree (per package manifest; the distributed license file carries no copyright line)
- **data-encoding 2.11.0** — Copyright (c) 2015-2020 Julien Cretin; Copyright (c) 2017-2020 Google Inc
- **dbus 0.9.12** — Copyright (c) 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors
- **der 0.7.10** — Copyright (c) 2020-2023 The RustCrypto Project Developers
- **der 0.8.1** — Copyright (c) 2020-2026 The RustCrypto Project Developers
- **deranged 0.5.8** — Copyright (c) 2024 Jacob Pratt et al
- **derive_arbitrary 1.4.2** — Copyright (c) 2019 Manish Goregaokar
- **derive_builder 0.20.2** — Copyright (c) 2016 rust-derive-builder contributors
- **derive_builder_core 0.20.2** — Copyright (c) 2016 rust-derive-builder contributors
- **derive_builder_macro 0.20.2** — Copyright (c) 2016 rust-derive-builder contributors
- **derive_more 2.1.1** — Copyright (c) 2016 Jelte Fennema
- **derive_more-impl 2.1.1** — Copyright (c) 2016 Jelte Fennema
- **digest 0.10.7** — Copyright (c) 2017 Artyom Pavlov
- **digest 0.11.3** — Copyright (c) 2017-2025 RustCrypto Developers; Copyright (c) 2017 Artyom Pavlov
- **dirs 6.0.0** — Copyright (c) 2018-2019 dirs-rs contributors
- **dirs-sys 0.5.0** — Copyright (c) 2018-2019 dirs-rs contributors
- **dispatch2 0.3.1** — Copyright Mads Marquart, Mary (per package manifest; the distributed license file carries no copyright line)
- **displaydoc 0.2.6** — Copyright Jane Lusby (per package manifest; the distributed license file carries no copyright line)
- **dlopen2 0.8.2** — Copyright Szymon Wieloch, Ahmed Masud, OpenByte (per package manifest; the distributed license file carries no copyright line)
- **dlopen2_derive 0.4.3** — Copyright Szymon Wieloch, OpenByte (per package manifest; the distributed license file carries no copyright line)
- **dom_query 0.27.0** — Copyright (c) 2023 Mykola Humanov
- **downcast-rs 1.2.1** — Copyright (c) 2020 Ashish Myles and contributors
- **dtoa 1.0.11** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **dtor 0.3.0** — Copyright Matt Mastracci (per package manifest; the distributed license file carries no copyright line)
- **dtor-proc-macro 0.0.6** — Copyright Matt Mastracci (per package manifest; the distributed license file carries no copyright line)
- **dyn-clone 1.0.20** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **ed25519 2.2.3** — Copyright (c) 2018-2023 RustCrypto Developers
- **either 1.16.0** — Copyright (c) 2015
- **embed_plist 1.2.2** — Copyright (c) 2020 Nikolai Vazquez
- **embed-resource 3.0.11** — Copyright (c) 2017 nabijaczleweli
- **endi 1.1.1** — Copyright Zeeshan Ali Khan (per package manifest; the distributed license file carries no copyright line)
- **enumflags2 0.7.12** — Copyright 2017-2023 Maik Klein, Maja Kądziołka
- **enumflags2_derive 0.7.12** — Copyright (c) 2017 Maik Klein
- **env_filter 0.1.4** — Copyright (c) Individual contributors
- **env_logger 0.10.2** — Copyright (c) Individual contributors
- **equivalent 1.0.2** — Copyright (c) 2016--2023
- **erased-serde 0.4.10** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **errno 0.3.14** — Copyright (c) 2014 Chris Wong
- **event-listener 5.4.1** — Copyright Stjepan Glavina, John Nunley (per package manifest; the distributed license file carries no copyright line)
- **event-listener-strategy 0.5.4** — Copyright John Nunley (per package manifest; the distributed license file carries no copyright line)
- **fallible-iterator 0.3.0** — Copyright (c) 2015 The rust-openssl-verify Developers
- **fallible-streaming-iterator 0.1.9** — Copyright (c) 2016 The fallible-streaming-iterator Developers
- **fastrand 2.4.1** — Copyright Stjepan Glavina (per package manifest; the distributed license file carries no copyright line)
- **fdeflate 0.3.7** — Copyright The image-rs Developers (per package manifest; the distributed license file carries no copyright line)
- **fern 0.7.1** — Copyright (c) 2014-2017 David Ross
- **fiat-crypto 0.2.9** — Copyright 2015-2020 the fiat-crypto authors (see the AUTHORS file)
- **field-offset 0.3.6** — Copyright (c) 2016-2021 Diggory Blake, and other contributors
- **filedescriptor 0.8.3** — Copyright (c) 2018 Wez Furlong
- **filetime 0.2.29** — Copyright (c) 2014 Alex Crichton
- **find-msvc-tools 0.1.9** — Copyright (c) 2014 Alex Crichton
- **flate2 1.1.9** — Copyright (c) 2014-2026 Alex Crichton
- **fnv 1.0.7** — Copyright (c) 2017 Contributors
- **foreign-types 0.3.2** — Copyright (c) 2017 The foreign-types Developers
- **foreign-types 0.5.0** — Copyright (c) 2017 The foreign-types Developers
- **foreign-types-macros 0.2.3** — Copyright (c) 2017 The foreign-types Developers
- **foreign-types-shared 0.1.1** — Copyright (c) 2017 The foreign-types Developers
- **foreign-types-shared 0.3.1** — Copyright (c) 2017 The foreign-types Developers
- **form_urlencoded 1.2.2** — Copyright (c) 2013-2016 The rust-url developers
- **fsevent-sys 4.1.0** — Copyright (c) 2015 Pierre Baillet
- **futures-channel 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-core 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-executor 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-io 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-lite 2.6.1** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-macro 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-sink 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-task 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **futures-util 0.3.32** — Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors
- **gdk 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdk-pixbuf 0.18.5** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdk-pixbuf-sys 0.18.0** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdk-sys 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdkwayland-sys 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdkx11 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gdkx11-sys 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **generic-array 0.14.7** — Copyright (c) 2015 Bartłomiej Kamiński
- **getrandom 0.2.17** — Copyright (c) 2018-2024 The rust-random Project Developers; Copyright (c) 2014 The Rust Project Developers
- **getrandom 0.3.4** — Copyright (c) 2018-2025 The rust-random Project Developers; Copyright (c) 2014 The Rust Project Developers
- **getrandom 0.4.3** — Copyright (c) 2018-2026 The rust-random Project Developers; Copyright (c) 2014 The Rust Project Developers
- **gio 0.18.4** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gio-sys 0.18.1** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **glib 0.18.5** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **glib-macros 0.18.5** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **glib-sys 0.18.1** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **glob 0.3.3** — Copyright (c) 2014 The Rust Project Developers
- **globset 0.4.19** — Copyright (c) 2015 Andrew Gallant
- **gobject-sys 0.18.0** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gtk 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gtk-sys 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **gtk3-macros 0.18.2** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **hashbrown 0.12.3** — Copyright (c) 2016 Amanieu d'Antras
- **hashbrown 0.14.5** — Copyright (c) 2016 Amanieu d'Antras
- **hashbrown 0.17.1** — Copyright (c) 2016 Amanieu d'Antras
- **hashlink 0.9.1** — Copyright kyren (per package manifest; the distributed license file carries no copyright line)
- **heck 0.4.1** — Copyright (c) 2015 The Rust Project Developers
- **heck 0.5.0** — Copyright (c) 2015 The Rust Project Developers
- **hermit-abi 0.5.2** — Copyright Stefan Lankes (per package manifest; the distributed license file carries no copyright line)
- **hex 0.4.3** — Copyright (c) 2013-2014 The Rust Project Developers; Copyright (c) 2015-2020 The rust-hex Developers
- **hex-literal 1.1.0** — Copyright (c) 2018-2025 The RustCrypto Project Developers; Copyright (c) 2018 Artyom Pavlov
- **hkdf 0.12.4** — Copyright (c) 2015-2018 Vlad Filippov; Copyright (c) 2018-2021 RustCrypto Developers
- **hmac 0.12.1** — Copyright (c) 2017 Artyom Pavlov
- **hmac 0.13.0** — Copyright (c) 2017 Artyom Pavlov
- **html5ever 0.38.0** — Copyright (c) 2014 The html5ever Project Developers
- **http 1.4.2** — Copyright (c) 2017 http-rs authors
- **http-body 1.1.0** — Copyright (c) 2019-2026 Sean McArthur & Hyper Contributors
- **http-body-util 0.1.4** — Copyright (c) 2019-2026 Sean McArthur & Hyper Contributors
- **httparse 1.10.1** — Copyright (c) 2015-2025 Sean McArthur
- **httpdate 1.0.3** — Copyright (c) 2016 Pyfisch
- **humantime 2.4.0** — Copyright (c) 2016 The humantime Developers; Copyright (c) 2016 Pyfisch; Copyright © 2005-2013 Rich Felker
- **hybrid-array 0.4.13** — Copyright (c) 2022-2026 The RustCrypto Project Developers
- **hyper 1.10.1** — Copyright (c) 2014-2026 Sean McArthur
- **hyper-rustls 0.27.9** — Copyright (c) 2016, Joseph Birr-Pixton <jpixton@gmail.com>
- **hyper-util 0.1.20** — Copyright (c) 2023-2025 Sean McArthur
- **iana-time-zone 0.1.65** — Copyright (c) 2020 Andrew D. Straw
- **iana-time-zone-haiku 0.1.2** — Copyright (c) 2020 Andrew D. Straw
- **ico 0.5.0** — Copyright (c) 2018 Matthew D. Steele
- **ident_case 1.0.1** — Copyright Ted Driggs (per package manifest; the distributed license file carries no copyright line)
- **idna 1.1.0** — Copyright (c) 2013-2025 The rust-url developers
- **idna_adapter 1.2.2** — Copyright (c) The rust-url developers
- **ignore 0.4.31** — Copyright (c) 2015 Andrew Gallant
- **image 0.25.10** — Copyright The image-rs Developers (per package manifest; the distributed license file carries no copyright line)
- **include_dir 0.7.4** — Copyright Michael Bryan (per package manifest; the distributed license file carries no copyright line)
- **include_dir_macros 0.7.4** — Copyright Michael Bryan (per package manifest; the distributed license file carries no copyright line)
- **indexmap 1.9.3** — Copyright (c) 2016--2017
- **indexmap 2.14.0** — Copyright (c) 2016--2017
- **infer 0.19.0** — Copyright (c) 2019 Bojan
- **inout 0.1.4** — Copyright (c) 2022 The RustCrypto Project Developers; Copyright (c) 2022 Artyom Pavlov
- **inout 0.2.2** — Copyright (c) 2022-2025 The RustCrypto Project Developers; Copyright (c) 2022 Artyom Pavlov
- **ipnet 2.12.0** — Copyright 2017 Juniper Networks, Inc
- **is-docker 0.2.0** — Copyright (c) 2023 Sean Larkin
- **is-terminal 0.4.17** — Copyright (c) 2015-2019 Doug Tangren
- **is-wsl 0.4.0** — Copyright (c) 2023 Sean Larkin
- **itoa 1.0.18** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **javascriptcore-rs 1.1.2** — Copyright (c) 2013-2021, The Gtk-rs Project Developers; Copyright (c) 2021, Tauri Programme within The Commons Conservancy
- **javascriptcore-rs-sys 1.1.1** — Copyright (c) 2013-2017, The Gtk-rs Project Developers
- **jni 0.21.1** — Copyright (c) 2016 Prevoty, Inc. and jni-rs contributors
- **jni 0.22.4** — Copyright jni team (per package manifest; the distributed license file carries no copyright line)
- **jni-macros 0.22.4** — no copyright line in the distributed license file
- **jni-sys 0.3.1** — Copyright (c) 2015 The rust-jni-sys Developers
- **jni-sys 0.4.1** — Copyright (c) 2015 The rust-jni-sys Developers
- **jni-sys-macros 0.4.1** — Copyright Robert Bragg (per package manifest; the distributed license file carries no copyright line)
- **js-sys 0.3.103** — Copyright (c) 2014 Alex Crichton
- **json-patch 3.0.1** — Copyright (c) 2017 Ivan Dubrov
- **jsonptr 0.6.3** — Copyright (c) 2022 Chance Dinkins
- **keepass 0.13.18** — Copyright (c) 2019 Stefan Seemayer
- **keyboard-types 0.7.0** — Copyright (c) 2017 Pyfisch
- **kqueue 1.2.0** — Copyright (c) 2016 William Orr <will@worrbase.com>
- **kqueue-sys 1.1.2** — Copyright (c) 2016 William Orr <will@worrbase.com>
- **lazy_static 1.5.0** — Copyright (c) 2010 The Rust Project Developers
- **libappindicator 0.9.0** — Copyright (c) 2017-2021 qDot; Copyright (c) 2021 Tauri Apps Contributors
- **libappindicator-sys 0.9.0** — no copyright line in the distributed license file
- **libc 0.2.186** — Copyright (c) The Rust Project Developers
- **libdbus-sys 0.2.7** — Copyright (c) 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors
- **libredox 0.1.18** — Copyright (c) 2023 4lDO2
- **libsqlite3-sys 0.30.1** — Copyright (c) 2014-2021 The rusqlite developers
- **linux-raw-sys 0.12.1** — Copyright Dan Gohman (per package manifest; the distributed license file carries no copyright line)
- **lock_api 0.4.14** — Copyright (c) 2016 The Rust Project Developers
- **log 0.4.33** — Copyright (c) 2014 The Rust Project Developers
- **lru-slab 0.1.2** — Copyright (c) 2024 The lru-slab Developers
- **mac-notification-sys 0.6.15** — Copyright Felix Döring, Hendrik Sollich (per package manifest; the distributed license file carries no copyright line)
- **mach2 0.4.3** — Copyright (c) 2019 Nick Fitzgerald, 2021 Yuki Okushi
- **markup5ever 0.38.0** — Copyright (c) 2014 The html5ever Project Developers
- **matrixmultiply 0.3.11** — Copyright (c) 2016 - 2023 Ulrik Sverdrup "bluss"; Copyright (c) 2021 DutchGhost [constparse.rs]
- **memchr 2.8.3** — Copyright (c) 2015 Andrew Gallant
- **memoffset 0.9.1** — Copyright (c) 2017 Gilad Naaman
- **mime 0.3.17** — Copyright (c) 2014 Sean McArthur
- **minisign-verify 0.2.5** — Copyright (c) 2019-2025 Frank Denis; Copyright (c) 2006-2009 Graydon Hoare
- **miniz_oxide 0.8.9** — Copyright 2013-2014 RAD Game Tools and Valve Software; Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC; Copyright (c) 2017 Frommi; Copyright (c) 2017-2024 oyvindln
- **mio 1.2.2** — Copyright (c) 2014 Carl Lerche and other MIO contributors
- **muda 0.19.3** — Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy
- **native-tls 0.2.18** — Copyright (c) 2016 The rust-native-tls Developers
- **ndarray 0.17.2** — Copyright (c) 2015 - 2021 Ulrik Sverdrup "bluss"
- **ndk 0.9.0** — Copyright The Rust Mobile contributors (per package manifest; the distributed license file carries no copyright line)
- **ndk-context 0.1.1** — Copyright The Rust Windowing contributors (per package manifest; the distributed license file carries no copyright line)
- **ndk-sys 0.6.0+11769913** — Copyright The Rust Windowing contributors (per package manifest; the distributed license file carries no copyright line)
- **new_debug_unreachable 1.0.6** — Copyright (c) 2015 Jonathan Reem
- **nix 0.28.0** — Copyright (c) 2015 Carl Lerche + nix-rust Authors
- **notify-rust 4.18.0** — Copyright (c) 2017 Hendrik Sollich
- **notify-types 2.1.0** — Copyright (c) 2023 Notify Contributors
- **ntapi 0.4.3** — Copyright MSxDOS (per package manifest; the distributed license file carries no copyright line)
- **num_enum 0.7.6** — Copyright (c) 2018, Daniel Wagner-Hall
- **num_enum_derive 0.7.6** — Copyright (c) 2018, Daniel Wagner-Hall
- **num_threads 0.1.7** — Copyright (c) 2021 Jacob Pratt
- **num-complex 0.4.6** — Copyright (c) 2014 The Rust Project Developers
- **num-conv 0.2.2** — Copyright (c) Jacob Pratt
- **num-derive 0.4.2** — Copyright (c) 2014 The Rust Project Developers
- **num-integer 0.1.46** — Copyright (c) 2014 The Rust Project Developers
- **num-traits 0.2.19** — Copyright (c) 2014 The Rust Project Developers
- **objc2 0.6.4** — Copyright Mads Marquart (per package manifest; the distributed license file carries no copyright line)
- **objc2-app-kit 0.3.2** — no copyright line in the distributed license file
- **objc2-audio-toolbox 0.3.2** — no copyright line in the distributed license file
- **objc2-cloud-kit 0.3.2** — no copyright line in the distributed license file
- **objc2-core-audio 0.3.2** — no copyright line in the distributed license file
- **objc2-core-audio-types 0.3.2** — no copyright line in the distributed license file
- **objc2-core-data 0.3.2** — no copyright line in the distributed license file
- **objc2-core-foundation 0.3.2** — no copyright line in the distributed license file
- **objc2-core-graphics 0.3.2** — no copyright line in the distributed license file
- **objc2-core-image 0.3.2** — no copyright line in the distributed license file
- **objc2-core-location 0.3.2** — no copyright line in the distributed license file
- **objc2-core-text 0.3.2** — no copyright line in the distributed license file
- **objc2-core-video 0.3.2** — no copyright line in the distributed license file
- **objc2-encode 4.1.0** — Copyright Mads Marquart (per package manifest; the distributed license file carries no copyright line)
- **objc2-exception-helper 0.1.1** — Copyright Mads Marquart (per package manifest; the distributed license file carries no copyright line)
- **objc2-foundation 0.3.2** — no copyright line in the distributed license file
- **objc2-io-surface 0.3.2** — no copyright line in the distributed license file
- **objc2-javascript-core 0.3.2** — no copyright line in the distributed license file
- **objc2-osa-kit 0.3.2** — no copyright line in the distributed license file
- **objc2-quartz-core 0.3.2** — no copyright line in the distributed license file
- **objc2-security 0.3.2** — no copyright line in the distributed license file
- **objc2-ui-kit 0.3.2** — no copyright line in the distributed license file
- **objc2-user-notifications 0.3.2** — no copyright line in the distributed license file
- **objc2-web-kit 0.3.2** — no copyright line in the distributed license file
- **once_cell 1.21.4** — Copyright Aleksey Kladov (per package manifest; the distributed license file carries no copyright line)
- **opaque-debug 0.3.1** — Copyright (c) 2018-2024 The RustCrypto Project Developers
- **open 5.4.0** — Copyright © `2015` `Sebastian Thiel`
- **openssl-macros 0.1.1** — Copyright (c) 2022 Steven Fackler
- **openssl-probe 0.2.1** — Copyright (c) 2014 Alex Crichton
- **openssl-sys 0.9.117** — Copyright (c) 2014 Alex Crichton
- **ordered-stream 0.2.0** — Copyright Daniel De Graaf, Zeeshan Ali Khan (per package manifest; the distributed license file carries no copyright line)
- **ort 2.0.0-rc.12** — Copyright (c) 2023-2026 pyke.io; Copyright (c) 2020 Nicolas Bigaouette
- **ort-sys 2.0.0-rc.12** — Copyright (c) 2023-2026 pyke.io; Copyright (c) 2020 Nicolas Bigaouette
- **osakit 0.3.1** — Copyright (c) 2024 Marat Dulin
- **pango 0.18.3** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **pango-sys 0.18.0** — Copyright The gtk-rs Project Developers (per package manifest; the distributed license file carries no copyright line)
- **parking 2.2.1** — Copyright 2014-2020 The Rust Project Developers
- **parking_lot 0.12.5** — Copyright (c) 2016 The Rust Project Developers
- **parking_lot_core 0.9.12** — Copyright (c) 2016 The Rust Project Developers
- **password-hash 0.5.0** — Copyright (c) 2020-2023 RustCrypto Developers
- **pem-rfc7468 1.0.0** — Copyright (c) 2021-2025 The RustCrypto Project Developers
- **percent-encoding 2.3.2** — Copyright (c) 2013-2025 The rust-url developers
- **phf 0.13.1** — Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi
- **phf_codegen 0.13.1** — Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi
- **phf_generator 0.13.1** — Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi
- **phf_macros 0.13.1** — Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi
- **phf_shared 0.13.1** — Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi
- **pin-project-lite 0.2.17** — no copyright line in the distributed license file
- **piper 0.2.5** — Copyright Stjepan Glavina, John Nunley (per package manifest; the distributed license file carries no copyright line)
- **pkcs8 0.10.2** — Copyright (c) 2020-2023 The RustCrypto Project Developers
- **pkg-config 0.3.33** — Copyright (c) 2014 Alex Crichton
- **plist 1.10.0** — Copyright (c) 2015 Edward Barnard
- **png 0.17.16** — Copyright (c) 2015 nwin
- **png 0.18.1** — Copyright (c) 2015 nwin
- **polling 3.11.0** — Copyright Stjepan Glavina, John Nunley (per package manifest; the distributed license file carries no copyright line)
- **poly1305 0.8.0** — Copyright (c) 2015-2019 RustCrypto Developers
- **portable-atomic 1.14.0** — no copyright line in the distributed license file
- **portable-atomic-util 0.2.7** — no copyright line in the distributed license file
- **portable-pty 0.9.0** — Copyright (c) 2018 Wez Furlong
- **powerfmt 0.2.0** — Copyright (c) 2023 Jacob Pratt et al
- **ppv-lite86 0.2.21** — Copyright (c) 2019 The CryptoCorrosion Contributors
- **precomputed-hash 0.1.1** — Copyright (c) 2017 Emilio Cobos Álvarez
- **primal-check 0.3.4** — Copyright (c) 2014 Huon Wilson
- **proc-macro-crate 1.3.1** — Copyright Bastian Köcher (per package manifest; the distributed license file carries no copyright line)
- **proc-macro-crate 2.0.2** — Copyright Bastian Köcher (per package manifest; the distributed license file carries no copyright line)
- **proc-macro-crate 3.5.0** — Copyright Bastian Köcher (per package manifest; the distributed license file carries no copyright line)
- **proc-macro-error 1.0.4** — Copyright (c) 2019-2020 CreepySkeleton
- **proc-macro-error-attr 1.0.4** — Copyright (c) 2019-2020 CreepySkeleton
- **proc-macro2 1.0.106** — Copyright David Tolnay, Alex Crichton (per package manifest; the distributed license file carries no copyright line)
- **qrcode 0.14.1** — Copyright (c) 2016 kennytm
- **quick-xml 0.41.0** — Copyright (c) 2016 Johann Tuffe
- **quinn 0.11.11** — Copyright (c) 2018 The quinn Developers
- **quinn-proto 0.11.16** — Copyright (c) 2018 The quinn Developers
- **quinn-udp 0.5.15** — Copyright (c) 2018 The quinn Developers
- **quote 1.0.46** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **r-efi 5.3.0** — no copyright line in the distributed license file
- **r-efi 6.0.0** — no copyright line in the distributed license file
- **rand 0.10.2** — copyright assignment is required to contribute to the Rand project
- **rand 0.8.7** — copyright assignment is required to contribute to the Rand project
- **rand 0.9.5** — copyright assignment is required to contribute to the Rand project
- **rand_chacha 0.3.1** — copyright assignment is required to contribute to the Rand project
- **rand_chacha 0.9.0** — copyright assignment is required to contribute to the Rand project
- **rand_core 0.10.1** — copyright assignment is required to contribute to the Rand project
- **rand_core 0.6.4** — copyright assignment is required to contribute to the Rand project
- **rand_core 0.9.5** — copyright assignment is required to contribute to the Rand project
- **rand_pcg 0.10.2** — copyright assignment is required to contribute to the Rand project
- **raw-window-handle 0.6.2** — Copyright (c) 2019 Osspial
- **rawpointer 0.2.1** — Copyright (c) 2015
- **rayon 1.12.0** — Copyright (c) 2010 The Rust Project Developers
- **rayon-core 1.13.0** — Copyright (c) 2010 The Rust Project Developers
- **realfft 3.5.0** — Copyright HEnquist (per package manifest; the distributed license file carries no copyright line)
- **redox_syscall 0.5.18** — Copyright (c) 2017 Redox OS Developers
- **redox_users 0.5.2** — Copyright (c) 2017 Jose Narvaez
- **ref-cast 1.0.25** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **ref-cast-impl 1.0.25** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **regex 1.13.1** — Copyright (c) 2014 The Rust Project Developers
- **regex-automata 0.4.16** — Copyright (c) 2014 The Rust Project Developers
- **regex-syntax 0.8.11** — Copyright (c) 2014 The Rust Project Developers
- **reqwest 0.12.28** — Copyright (c) 2016-2025 Sean McArthur
- **reqwest 0.13.4** — Copyright (c) 2016-2026 Sean McArthur
- **rfd 0.16.0** — Copyright (c) 2022 Bartłomiej Maryńczak
- **rubato 0.16.2** — Copyright (c) 2020 Henrik Enquist
- **rusqlite 0.32.1** — Copyright (c) 2014-2021 The rusqlite developers
- **rust-argon2 3.0.0** — Copyright (c) 2017 Martijn Rijkeboer <mrr@sru-systems.com>
- **rustc_version 0.4.1** — Copyright (c) 2016 The Rust Project Developers
- **rustc-hash 2.1.3** — no copyright line in the distributed license file
- **rustfft 6.4.1** — Copyright (c) 2015 The RustFFT Developers
- **rustix 1.1.4** — Copyright Dan Gohman, Jakub Konka (per package manifest; the distributed license file carries no copyright line)
- **rustls 0.23.42** — Copyright (c) 2016, Joseph Birr-Pixton <jpixton@gmail.com>
- **rustls-native-certs 0.8.4** — Copyright (c) 2016, Joseph Birr-Pixton <jpixton@gmail.com>
- **rustls-pki-types 1.15.0** — Copyright (c) 2023 Dirkjan Ochtman <dirkjan@ochtman.nl>
- **rustls-platform-verifier 0.7.0** — Copyright (c) 2022 1Password
- **rustls-platform-verifier-android 0.1.1** — no copyright line in the distributed license file
- **rustversion 1.0.23** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **salsa20 0.11.0** — Copyright (c) 2019-2026 The RustCrypto Project Developers; Copyright (c) 2019 Eric McCorkle
- **same-file 1.0.6** — Copyright (c) 2017 Andrew Gallant
- **schannel 0.1.29** — Copyright (c) 2015 steffengy
- **schemars 0.8.22** — Copyright (c) 2019 Graham Esau
- **schemars 0.9.0** — Copyright (c) 2019 Graham Esau
- **schemars 1.2.1** — Copyright (c) 2019 Graham Esau
- **schemars_derive 0.8.22** — Copyright (c) 2019 Graham Esau
- **scopeguard 1.2.0** — Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers
- **secrecy 0.10.3** — Copyright (c) 2019-2024 iqlusion
- **security-framework 3.7.0** — Copyright (c) 2015 Steven Fackler
- **security-framework-sys 2.17.0** — Copyright (c) 2015 Steven Fackler
- **semver 1.0.28** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde 1.0.228** — Copyright Erick Tryzelaar, David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_core 1.0.228** — Copyright Erick Tryzelaar, David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_derive 1.0.228** — Copyright Erick Tryzelaar, David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_derive_internals 0.29.1** — Copyright Erick Tryzelaar, David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_json 1.0.150** — Copyright Erick Tryzelaar, David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_path_to_error 0.1.20** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_repr 0.1.20** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serde_spanned 0.6.9** — Copyright (c) Individual contributors
- **serde_spanned 1.1.1** — Copyright (c) Individual contributors
- **serde_urlencoded 0.7.1** — Copyright (c) 2016 Anthony Ramine
- **serde_with 3.21.0** — Copyright (c) 2015
- **serde_with_macros 3.21.0** — Copyright (c) 2015
- **serde-untagged 0.1.9** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **serialize-to-javascript 0.1.2** — Copyright (c) 2021 Chip Reed
- **serialize-to-javascript-impl 0.1.2** — Copyright (c) 2021 Chip Reed
- **servo_arc 0.4.3** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **sha1 0.10.7** — Copyright (c) 2006-2009 Graydon Hoare; Copyright (c) 2016 Artyom Pavlov
- **sha2 0.10.9** — Copyright (c) 2006-2009 Graydon Hoare; Copyright (c) 2016 Artyom Pavlov
- **sha2 0.11.0** — Copyright (c) 2016-2026 The RustCrypto Project Developers; Copyright (c) 2016 Artyom Pavlov; Copyright (c) 2006-2009 Graydon Hoare
- **shared_library 0.1.9** — Copyright (c) 2017 Pierre Krieger
- **shell-words 1.1.1** — Copyright (c) 2016 Tomasz Miąsko
- **shlex 2.0.1** — Copyright 2015 Nicholas Allegra (comex)
- **signal-hook-registry 1.4.8** — Copyright (c) 2017 tokio-jsonrpc developers
- **signature 2.2.0** — Copyright (c) 2018-2023 RustCrypto Developers
- **simd_cesu8 1.2.0** — Copyright Sean C. Roach (per package manifest; the distributed license file carries no copyright line)
- **simd-adler32 0.3.10** — Copyright (c) [2021] [Marvin Countryman]
- **simdutf8 0.1.5** — Copyright Hans Kratz (per package manifest; the distributed license file carries no copyright line)
- **siphasher 1.0.3** — Copyright 2012-2016 The Rust Project Developers; Copyright 2016-2026 Frank Denis
- **slab 0.4.12** — Copyright (c) 2019 Carl Lerche
- **smallvec 1.15.2** — Copyright (c) 2018 The Servo Project Developers
- **socket2 0.6.5** — Copyright (c) 2014 Alex Crichton
- **socks 0.3.4** — Copyright (c) 2015 The rust-socks Developers
- **softbuffer 0.4.8** — Copyright 2022 Kirill Chibisov
- **soup3 0.5.0** — Copyright (c) 2013-2017, The Gtk-rs Project Developers
- **soup3-sys 0.5.0** — Copyright (c) 2013-2017, The Gtk-rs Project Developers
- **spake2 0.4.0** — Copyright (c) 2017-2023 Brian Warner
- **spki 0.7.3** — Copyright (c) 2021-2023 The RustCrypto Project Developers
- **stable_deref_trait 1.2.1** — Copyright (c) 2017 Robert Grosse
- **strength_reduce 0.2.4** — Copyright (c) 2015 The RustFFT Developers
- **string_cache 0.9.0** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **string_cache_codegen 0.6.1** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)
- **strsim 0.11.1** — Copyright (c) 2015 Danny Guo; Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>; Copyright (c) 2018 Akash Kurdekar
- **swift-rs 1.0.7** — Copyright (c) 2023 The swift-rs Developers
- **syn 1.0.109** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **syn 2.0.119** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **syn 3.0.0** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **synstructure 0.13.2** — Copyright 2016 Nika Layzell
- **sysinfo 0.33.1** — Copyright (c) 2015 Guillaume Gomez
- **system-deps 6.2.2** — Copyright Guillaume Desmottes, Josh Triplett (per package manifest; the distributed license file carries no copyright line)
- **tao-macros 0.1.3** — Copyright Tauri Programme within The Commons Conservancy (per package manifest; the distributed license file carries no copyright line)
- **tar 0.4.46** — Copyright (c) The tar-rs Project Contributors
- **tauri 2.11.5** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-build 2.6.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-codegen 2.6.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-macros 2.6.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin 2.6.3** — Copyright Tauri Programme within The Commons Conservancy (per package manifest; the distributed license file carries no copyright line)
- **tauri-plugin-dialog 2.7.1** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-fs 2.5.1** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-log 2.9.0** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-notification 2.3.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-opener 2.5.4** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-process 2.3.1** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-plugin-single-instance 2.4.3** — Copyright (c) 2017 - Present The Tauri Programme in the Commons Conservancy
- **tauri-plugin-updater 2.10.1** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-runtime 2.11.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-runtime-wry 2.11.4** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-utils 2.9.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tauri-winres 0.3.6** — Copyright (c) 2023 - Present Tauri Apps Contributors; Copyright (c) 2016 Max Resch
- **tauri-winrt-notification 0.7.3** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **tempfile 3.27.0** — Copyright (c) 2015 Steven Allen
- **tendril 0.5.1** — Copyright (c) 2015 Keegan McAllister
- **termcolor 1.4.1** — Copyright (c) 2015 Andrew Gallant
- **thiserror 1.0.69** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **thiserror 2.0.18** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **thiserror-impl 1.0.69** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **thiserror-impl 2.0.18** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **time 0.3.53** — Copyright (c) Jacob Pratt et al
- **time-core 0.1.9** — Copyright (c) Jacob Pratt et al
- **time-macros 0.2.31** — Copyright (c) Jacob Pratt et al
- **tinyvec 1.12.0** — Copyright (c) 2019 Daniel "Lokathor" Gee
- **tinyvec_macros 0.1.1** — Copyright (c) 2020 Soveu
- **tokio 1.52.3** — Copyright (c) Tokio Contributors
- **tokio-macros 2.7.1** — Copyright (c) 2019 Yoshua Wuyts; Copyright (c) Tokio Contributors
- **tokio-rustls 0.26.4** — Copyright (c) 2017 quininer kel
- **tokio-tungstenite 0.24.0** — Copyright (c) 2017 Daniel Abramov; Copyright (c) 2017 Alexey Galakhov
- **tokio-util 0.7.18** — Copyright (c) Tokio Contributors
- **toml 0.8.2** — Copyright (c) Individual contributors
- **toml 0.9.12+spec-1.1.0** — Copyright (c) Individual contributors
- **toml 1.1.3+spec-1.1.0** — Copyright (c) Individual contributors
- **toml_datetime 0.6.3** — Copyright (c) 2014 Alex Crichton
- **toml_datetime 0.7.5+spec-1.1.0** — Copyright (c) Individual contributors
- **toml_datetime 1.1.1+spec-1.1.0** — Copyright (c) Individual contributors
- **toml_edit 0.19.15** — Copyright (c) Individual contributors
- **toml_edit 0.20.2** — Copyright (c) Individual contributors
- **toml_edit 0.25.13+spec-1.1.0** — Copyright (c) Individual contributors
- **toml_parser 1.1.2+spec-1.1.0** — Copyright (c) Individual contributors
- **toml_writer 1.1.2+spec-1.1.0** — Copyright (c) Individual contributors
- **tower 0.5.3** — Copyright (c) 2019 Tower Contributors
- **tower-http 0.6.11** — Copyright (c) 2019-2021 Tower Contributors
- **tower-layer 0.3.3** — Copyright (c) 2019 Tower Contributors
- **tower-service 0.3.3** — Copyright (c) 2019 Tower Contributors
- **tracing 0.1.44** — Copyright (c) 2019 Tokio Contributors
- **tracing-attributes 0.1.31** — Copyright (c) 2019 Tokio Contributors
- **tracing-core 0.1.36** — Copyright (c) 2019 Tokio Contributors
- **transcribe-rs 0.3.11** — Copyright (c) 2025 Ilya Stupakov
- **transpose 0.2.3** — Copyright (c) 2022 The transpose Developers
- **trash 5.2.6** — Copyright 2019 Artúr Barnabás Kovács
- **tray-icon 0.24.1** — Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy
- **try-lock 0.2.5** — Copyright (c) 2018-2023 Sean McArthur; Copyright (c) 2016 Alex Crichton
- **tungstenite 0.24.0** — Copyright (c) 2017 Alexey Galakhov; Copyright (c) 2016 Jason Housley
- **twofish 0.8.0** — Copyright (c) 2017-2024 The RustCrypto Project Developers; Copyright (c) 2017 Alexander Krotov
- **typeid 1.0.3** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **typenum 1.20.1** — Copyright (c) 2014 Paho Lurie-Gregg
- **uds_windows 1.2.1** — Copyright (c) Microsoft Corporation. All rights reserved
- **unic-char-property 0.9.0** — Copyright The UNIC Project Developers (per package manifest; the distributed license file carries no copyright line)
- **unic-char-range 0.9.0** — Copyright The UNIC Project Developers (per package manifest; the distributed license file carries no copyright line)
- **unic-common 0.9.0** — Copyright The UNIC Project Developers (per package manifest; the distributed license file carries no copyright line)
- **unic-ucd-ident 0.9.0** — Copyright The UNIC Project Developers (per package manifest; the distributed license file carries no copyright line)
- **unic-ucd-version 0.9.0** — Copyright The UNIC Project Developers (per package manifest; the distributed license file carries no copyright line)
- **unicode-segmentation 1.13.3** — Copyright (c) 2015 The Rust Project Developers
- **universal-hash 0.5.1** — Copyright (c) 2019-2020 RustCrypto Developers
- **ureq 3.3.0** — Copyright (c) 2019 Martin Algesten
- **ureq-proto 0.6.0** — Copyright 2022 Martin Algesten
- **url 2.5.8** — Copyright (c) 2013-2025 The rust-url developers
- **urlencoding 2.1.3** — Copyright Kornel, Bertram Truong (per package manifest; the distributed license file carries no copyright line)
- **urlpattern 0.3.0** — Copyright (c) 2021 the Deno authors
- **utf-8 0.7.6** — Copyright Simon Sapin (per package manifest; the distributed license file carries no copyright line)
- **utf8_iter 1.0.4** — Copyright Henri Sivonen (per package manifest; the distributed license file carries no copyright line)
- **utf8-zero 0.8.1** — Copyright Simon Sapin, Martin Algesten (per package manifest; the distributed license file carries no copyright line)
- **uuid 1.24.0** — Copyright (c) 2014 The Rust Project Developers; Copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon
- **vcpkg 0.2.15** — Copyright (c) 2017 Jim McGrath
- **version_check 0.9.5** — Copyright (c) 2017-2018 Sergio Benitez
- **version-compare 0.2.1** — Copyright (c) 2017 Tim Visée
- **vswhom 0.1.0** — Copyright (c) 2019 nabijaczleweli
- **vswhom-sys 0.1.3** — Copyright (c) 2019 nabijaczleweli
- **walkdir 2.5.0** — Copyright (c) 2015 Andrew Gallant
- **want 0.3.1** — Copyright (c) 2018-2019 Sean McArthur
- **wasi 0.11.1+wasi-snapshot-preview1** — Copyright The Cranelift Project Developers (per package manifest; the distributed license file carries no copyright line)
- **wasip2 1.0.4+wasi-0.2.12** — no copyright line in the distributed license file
- **wasm-bindgen 0.2.126** — Copyright (c) 2014 Alex Crichton
- **wasm-bindgen-futures 0.4.76** — Copyright (c) 2014 Alex Crichton
- **wasm-bindgen-macro 0.2.126** — Copyright (c) 2014 Alex Crichton
- **wasm-bindgen-macro-support 0.2.126** — Copyright (c) 2014 Alex Crichton
- **wasm-bindgen-shared 0.2.126** — Copyright (c) 2014 Alex Crichton
- **wasm-streams 0.4.2** — Copyright Mattias Buelens (per package manifest; the distributed license file carries no copyright line)
- **wasm-streams 0.5.0** — Copyright Mattias Buelens (per package manifest; the distributed license file carries no copyright line)
- **web_atoms 0.2.5** — Copyright (c) 2014 The html5ever Project Developers
- **web-sys 0.3.103** — Copyright (c) 2014 Alex Crichton
- **web-time 1.1.0** — Copyright (c) 2023 dAxpeDDa
- **webkit2gtk 2.0.2** — Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com>; Copyright (c) 2017-2021, The Gtk-rs Project Developers; Copyright (c) 2021, Tauri Programme within The Commons Conservancy
- **webkit2gtk-sys 2.0.2** — Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com>
- **webview2-com 0.38.2** — no copyright line in the distributed license file
- **webview2-com-macros 0.8.1** — no copyright line in the distributed license file
- **webview2-com-sys 0.38.2** — no copyright line in the distributed license file
- **winapi 0.3.9** — Copyright (c) 2015-2018 The winapi-rs Developers
- **winapi-i686-pc-windows-gnu 0.4.0** — Copyright Peter Atashian (per package manifest; the distributed license file carries no copyright line)
- **winapi-util 0.1.11** — Copyright (c) 2017 Andrew Gallant
- **winapi-x86_64-pc-windows-gnu 0.4.0** — Copyright Peter Atashian (per package manifest; the distributed license file carries no copyright line)
- **window-vibrancy 0.6.0** — Copyright (c) 2020-2022 Tauri Programme within The Commons Conservancy
- **windows 0.54.0** — Copyright (c) Microsoft Corporation
- **windows 0.56.0** — Copyright (c) Microsoft Corporation
- **windows 0.57.0** — Copyright (c) Microsoft Corporation
- **windows 0.61.3** — Copyright (c) Microsoft Corporation
- **windows_aarch64_gnullvm 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_aarch64_gnullvm 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_aarch64_gnullvm 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_aarch64_msvc 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_aarch64_msvc 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_aarch64_msvc 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_i686_gnu 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_i686_gnu 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_i686_gnu 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_i686_gnullvm 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_i686_gnullvm 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_i686_msvc 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_i686_msvc 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_i686_msvc 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnu 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnu 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnu 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnullvm 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnullvm 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_x86_64_gnullvm 0.53.1** — Copyright (c) Microsoft Corporation
- **windows_x86_64_msvc 0.42.2** — Copyright (c) Microsoft Corporation
- **windows_x86_64_msvc 0.52.6** — Copyright (c) Microsoft Corporation
- **windows_x86_64_msvc 0.53.1** — Copyright (c) Microsoft Corporation
- **windows-collections 0.2.0** — Copyright (c) Microsoft Corporation
- **windows-core 0.54.0** — Copyright (c) Microsoft Corporation
- **windows-core 0.56.0** — Copyright (c) Microsoft Corporation
- **windows-core 0.57.0** — Copyright (c) Microsoft Corporation
- **windows-core 0.61.2** — Copyright (c) Microsoft Corporation
- **windows-core 0.62.2** — Copyright (c) Microsoft Corporation
- **windows-future 0.2.1** — Copyright (c) Microsoft Corporation
- **windows-implement 0.56.0** — Copyright (c) Microsoft Corporation
- **windows-implement 0.57.0** — Copyright (c) Microsoft Corporation
- **windows-implement 0.60.2** — Copyright (c) Microsoft Corporation
- **windows-interface 0.56.0** — Copyright (c) Microsoft Corporation
- **windows-interface 0.57.0** — Copyright (c) Microsoft Corporation
- **windows-interface 0.59.3** — Copyright (c) Microsoft Corporation
- **windows-link 0.1.3** — Copyright (c) Microsoft Corporation
- **windows-link 0.2.1** — Copyright (c) Microsoft Corporation
- **windows-numerics 0.2.0** — Copyright (c) Microsoft Corporation
- **windows-result 0.1.2** — Copyright (c) Microsoft Corporation
- **windows-result 0.3.4** — Copyright (c) Microsoft Corporation
- **windows-result 0.4.1** — Copyright (c) Microsoft Corporation
- **windows-strings 0.4.2** — Copyright (c) Microsoft Corporation
- **windows-strings 0.5.1** — Copyright (c) Microsoft Corporation
- **windows-sys 0.45.0** — Copyright (c) Microsoft Corporation
- **windows-sys 0.52.0** — Copyright (c) Microsoft Corporation
- **windows-sys 0.59.0** — Copyright (c) Microsoft Corporation
- **windows-sys 0.60.2** — Copyright (c) Microsoft Corporation
- **windows-sys 0.61.2** — Copyright (c) Microsoft Corporation
- **windows-targets 0.42.2** — Copyright (c) Microsoft Corporation
- **windows-targets 0.52.6** — Copyright (c) Microsoft Corporation
- **windows-targets 0.53.5** — Copyright (c) Microsoft Corporation
- **windows-threading 0.1.0** — Copyright (c) Microsoft Corporation
- **windows-version 0.1.7** — Copyright (c) Microsoft Corporation
- **winnow 0.5.40** — no copyright line in the distributed license file
- **winnow 0.7.15** — no copyright line in the distributed license file
- **winnow 1.0.4** — no copyright line in the distributed license file
- **winreg 0.10.1** — Copyright (c) 2015 Igor Shaula
- **winreg 0.55.0** — Copyright (c) 2015 Igor Shaula
- **wit-bindgen 0.57.1** — Copyright Alex Crichton (per package manifest; the distributed license file carries no copyright line)
- **wry 0.55.1** — Copyright (c) 2020-2023 Ngo Iok Ui & Tauri Programme within The Commons Conservancy
- **x11 2.21.0** — Copyright daggerbot, Erle Pereira, AltF02 (per package manifest; the distributed license file carries no copyright line)
- **x11-dl 2.21.0** — Copyright daggerbot, Erle Pereira, AltF02 (per package manifest; the distributed license file carries no copyright line)
- **xattr 1.6.1** — Copyright (c) 2015 Steven Allen
- **zbus 5.18.0** — Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors
- **zbus_macros 5.18.0** — Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors
- **zbus_names 4.3.4** — Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors
- **zerocopy 0.8.54** — Copyright 2019 The Fuchsia Authors
- **zerocopy-derive 0.8.54** — Copyright 2019 The Fuchsia Authors
- **zeroize 1.9.0** — Copyright (c) 2018-2026 The RustCrypto Project Developers
- **zeroize_derive 1.5.0** — Copyright (c) 2019-2026 The RustCrypto Project Developers
- **zip 4.6.1** — Copyright (c) 2014 Mathijs van de Nes
- **zmij 1.0.23** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **zune-core 0.5.1** — Copyright (c) zune-image developers
- **zune-jpeg 0.5.15** — Copyright (c) zune-image developers
- **zvariant 5.13.1** — Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors
- **zvariant_derive 5.13.1** — Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors
- **zvariant_utils 3.5.0** — Copyright Zeeshan Ali Khan, turbocooler (per package manifest; the distributed license file carries no copyright line)

### Unicode-3.0 — 18

- **icu_collections 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_locale_core 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_normalizer 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_normalizer_data 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_properties 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_properties_data 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **icu_provider 2.2.0** — Copyright © 2020-2024 Unicode, Inc
- **litemap 0.8.2** — Copyright © 2020-2024 Unicode, Inc
- **potential_utf 0.1.5** — Copyright © 2020-2024 Unicode, Inc
- **tinystr 0.8.3** — Copyright © 2020-2024 Unicode, Inc
- **writeable 0.6.3** — Copyright © 2020-2024 Unicode, Inc
- **yoke 0.8.3** — Copyright © 2020-2024 Unicode, Inc
- **yoke-derive 0.8.2** — Copyright © 2020-2024 Unicode, Inc
- **zerofrom 0.1.8** — Copyright © 2020-2024 Unicode, Inc
- **zerofrom-derive 0.1.7** — Copyright © 2020-2024 Unicode, Inc
- **zerotrie 0.2.4** — Copyright © 2020-2024 Unicode, Inc
- **zerovec 0.11.6** — Copyright © 2020-2024 Unicode, Inc
- **zerovec-derive 0.11.3** — Copyright © 2020-2024 Unicode, Inc

### Apache-2.0 — 7

- **cpal 0.16.0** — no copyright line in the distributed license file
- **hound 3.5.1** — Copyright Ruud van Asseldonk (per package manifest; the distributed license file carries no copyright line)
- **lzma-rust2 0.15.8** — no copyright line in the distributed license file
- **openssl 0.10.81** — Copyright 2011-2017 Google Inc
- **ryu 1.0.23** — Copyright David Tolnay (per package manifest; the distributed license file carries no copyright line)
- **sync_wrapper 1.0.2** — Copyright Actyx AG (per package manifest; the distributed license file carries no copyright line)
- **tao 0.35.3** — Copyright Tauri Programme within The Commons Conservancy, The winit contributors (per package manifest; the distributed license file carries no copyright line)

### ISC — 7

- **hmac-sha256 1.1.14** — Copyright (c) 2019-2026, Frank Denis
- **inotify 0.11.4** — Copyright (c) Hanno Braun and contributors
- **inotify-sys 0.1.8** — Copyright (c) Hanno Braun and contributors
- **libloading 0.7.4** — Copyright © 2015, Simonas Kazlauskas
- **libloading 0.9.0** — Copyright © 2015, Simonas Kazlauskas
- **rustls-webpki 0.103.13** — Copyright 2015 Brian Smith
- **untrusted 0.9.0** — Copyright Brian Smith (per package manifest; the distributed license file carries no copyright line)

### BSD-3-Clause — 5

- **alloc-no-stdlib 2.0.4** — Copyright (c) 2016 Dropbox, Inc
- **alloc-stdlib 0.2.4** — Copyright Daniel Reiter Horn (per package manifest; the distributed license file carries no copyright line)
- **curve25519-dalek 4.1.3** — Copyright (c) 2016-2021 isis agora lovecruft. All rights reserved; Copyright (c) 2016-2021 Henry de Valence. All rights reserved; Copyright (c) 2012 The Go Authors. All rights reserved
- **ed25519-dalek 2.2.0** — Copyright (c) 2017-2019 isis agora lovecruft. All rights reserved
- **subtle 2.6.1** — Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved; Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved

### MPL-2.0 — 5

- **cssparser 0.36.0** — Copyright Simon Sapin (per package manifest; the distributed license file carries no copyright line)
- **cssparser-macros 0.6.1** — Copyright Simon Sapin (per package manifest; the distributed license file carries no copyright line)
- **dtoa-short 0.3.5** — Copyright Xidorn Quan (per package manifest; the distributed license file carries no copyright line)
- **option-ext 0.2.0** — Copyright Simon Ochsenreither (per package manifest; the distributed license file carries no copyright line)
- **selectors 0.36.1** — Copyright The Servo Project Developers (per package manifest; the distributed license file carries no copyright line)

### CDLA-Permissive-2.0 — 3

- **webpki-root-certs 1.0.8** — no copyright line in the distributed license file
- **webpki-roots 0.26.11** — no copyright line in the distributed license file
- **webpki-roots 1.0.9** — no copyright line in the distributed license file

### BSD-2-Clause — 2

- **arrayref 0.3.9** — Copyright (c) 2015 David Roundy <roundyd@physics.oregonstate.edu>
- **serial2 0.2.37** — Copyright 2021, Maarten de Vries <maarten@de-vri.es>

### BSD-3-Clause AND MIT — 2

- **brotli 8.0.4** — Copyright (c) 2016 Dropbox, Inc
- **matchit 0.7.3** — Copyright (c) 2022 Ibraheem Ahmed

### BSD-3-Clause OR Apache-2.0 — 2

- **moxcms 0.8.1** — Copyright (c) Radzivon Bartoshyk. All rights reserved
- **pxfm 0.1.30** — Copyright (c) Radzivon Bartoshyk. All rights reserved

### MIT-0 — 2

- **constant_time_eq 0.4.2** — Copyright Cesar Eduardo Barros (per package manifest; the distributed license file carries no copyright line)
- **dunce 1.0.5** — Copyright Kornel (per package manifest; the distributed license file carries no copyright line)

### Apache-2.0 AND ISC — 1

- **ring 0.17.14** — Copyright 2015-2025 Brian Smith

### Apache-2.0 AND MIT — 1

- **dpi 0.1.2** — Copyright (c) 2018 Jorge Aparicio; Copyright © 2005-2020 Rich Felker, et al; Copyright © 1993,2004 Sun Microsystems or; Copyright © 2003-2011 David Schultz or; Copyright © 2003-2009 Steven G. Kargl or; Copyright © 2003-2009 Bruce D. Evans or; Copyright © 2008 Stephen L. Moshier or; Copyright © 2017-2018 Arm Limited

### Apache-2.0 WITH LLVM-exception — 1

- **target-lexicon 0.12.16** — Copyright Dan Gohman (per package manifest; the distributed license file carries no copyright line)

### CC0-1.0 — 1

- **notify 8.2.0** — Copyright Félix Saparelli, Daniel Faust, Aron Heinecke (per package manifest; the distributed license file carries no copyright line)

### MIT AND Unicode-3.0 — 1

- **unicode-ident 1.0.24** — Copyright © 1991-2023 Unicode, Inc

### Zlib — 1

- **foldhash 0.2.0** — Copyright (c) 2024 Orson Peters

## npm packages (235)

### MIT — 173

- **@antfu/install-pkg 1.1.0** — Copyright (c) 2021 Anthony Fu <https://github.com/antfu>
- **@braintree/sanitize-url 7.1.2** — Copyright (c) 2017 Braintree
- **@codingame/monaco-vscode-api 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-base-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-bulk-edit-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-configuration-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-editor-api 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-editor-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-environment-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-extension-api 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-extensions-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-files-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-host-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-keybindings-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-cs 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-de 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-es 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-fr 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-it 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-ja 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-ko 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-pl 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-pt-br 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-qps-ploc 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-ru 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-tr 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-zh-hans 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-language-pack-zh-hant 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-languages-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-layout-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-localization-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-log-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-model-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-monarch-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-quickaccess-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-standalone-languages 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-textmate-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-theme-defaults-default-extension 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-theme-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-view-banner-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-view-common-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-view-status-bar-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-view-title-bar-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-views-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@codingame/monaco-vscode-workbench-service-override 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **@git-diff-view/core 0.1.7** — Copyright (c) 2022 MrWangJustToDo
- **@git-diff-view/lowlight 0.1.7** — Copyright (c) 2022 MrWangJustToDo
- **@git-diff-view/react 0.1.7** — Copyright (c) 2022 MrWangJustToDo
- **@iconify/types 2.0.0** — Copyright (c) 2021 - 2022 Vjacheslav Trushkin / Iconify OÜ
- **@iconify/utils 3.1.4** — Copyright (c) 2021-PRESENT Vjacheslav Trushkin
- **@mermaid-js/parser 1.2.0** — Copyright (c) 2023 Yokozuna59
- **@tauri-apps/api 2.11.1** — Copyright (c) 2017 - Present Tauri Apps Contributors
- **@tauri-apps/plugin-dialog 2.7.1** — no copyright line in the distributed license file
- **@tauri-apps/plugin-notification 2.3.3** — no copyright line in the distributed license file
- **@tauri-apps/plugin-opener 2.5.4** — no copyright line in the distributed license file
- **@tauri-apps/plugin-process 2.3.1** — no copyright line in the distributed license file
- **@tauri-apps/plugin-updater 2.10.1** — no copyright line in the distributed license file
- **@types/d3 7.4.3** — Copyright (c) Microsoft Corporation
- **@types/d3-array 3.2.2** — Copyright (c) Microsoft Corporation
- **@types/d3-axis 3.0.6** — Copyright (c) Microsoft Corporation
- **@types/d3-brush 3.0.6** — Copyright (c) Microsoft Corporation
- **@types/d3-chord 3.0.6** — Copyright (c) Microsoft Corporation
- **@types/d3-color 3.1.3** — Copyright (c) Microsoft Corporation
- **@types/d3-contour 3.0.6** — Copyright (c) Microsoft Corporation
- **@types/d3-delaunay 6.0.4** — Copyright (c) Microsoft Corporation
- **@types/d3-dispatch 3.0.7** — Copyright (c) Microsoft Corporation
- **@types/d3-drag 3.0.7** — Copyright (c) Microsoft Corporation
- **@types/d3-dsv 3.0.7** — Copyright (c) Microsoft Corporation
- **@types/d3-ease 3.0.2** — Copyright (c) Microsoft Corporation
- **@types/d3-fetch 3.0.7** — Copyright (c) Microsoft Corporation
- **@types/d3-force 3.0.10** — Copyright (c) Microsoft Corporation
- **@types/d3-format 3.0.4** — Copyright (c) Microsoft Corporation
- **@types/d3-geo 3.1.0** — Copyright (c) Microsoft Corporation
- **@types/d3-hierarchy 3.1.7** — Copyright (c) Microsoft Corporation
- **@types/d3-interpolate 3.0.4** — Copyright (c) Microsoft Corporation
- **@types/d3-path 3.1.1** — Copyright (c) Microsoft Corporation
- **@types/d3-polygon 3.0.2** — Copyright (c) Microsoft Corporation
- **@types/d3-quadtree 3.0.6** — Copyright (c) Microsoft Corporation
- **@types/d3-random 3.0.4** — Copyright (c) Microsoft Corporation
- **@types/d3-scale 4.0.9** — Copyright (c) Microsoft Corporation
- **@types/d3-scale-chromatic 3.1.0** — Copyright (c) Microsoft Corporation
- **@types/d3-selection 3.0.11** — Copyright (c) Microsoft Corporation
- **@types/d3-shape 3.1.8** — Copyright (c) Microsoft Corporation
- **@types/d3-time 3.0.4** — Copyright (c) Microsoft Corporation
- **@types/d3-time-format 4.0.3** — Copyright (c) Microsoft Corporation
- **@types/d3-timer 3.0.2** — Copyright (c) Microsoft Corporation
- **@types/d3-transition 3.0.9** — Copyright (c) Microsoft Corporation
- **@types/d3-zoom 3.0.8** — Copyright (c) Microsoft Corporation
- **@types/geojson 7946.0.16** — Copyright (c) Microsoft Corporation
- **@types/hast 3.0.5** — Copyright (c) Microsoft Corporation
- **@types/trusted-types 2.0.7** — Copyright (c) Microsoft Corporation
- **@types/unist 3.0.3** — Copyright (c) Microsoft Corporation
- **@upsetjs/venn.js 2.0.0** — Copyright (c) 2013 Ben Frederickson; Copyright (c) 2021 Samuel Gratzl
- **@vscode/iconv-lite-umd 0.7.1** — Copyright (c) Microsoft Corporation
- **@vue/reactivity 3.5.40** — Copyright (c) 2018-present, Yuxi (Evan) You
- **@vue/shared 3.5.40** — Copyright (c) 2018-present, Yuxi (Evan) You
- **@xmldom/xmldom 0.8.13** — Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors; Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors
- **@xterm/addon-fit 0.11.0** — Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- **@xterm/addon-unicode11 0.9.0** — Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- **@xterm/addon-web-links 0.12.0** — Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- **@xterm/xterm 6.0.0** — Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com); Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
- **argparse 1.0.10** — Copyright (C) 2012 by Vitaly Puzrin
- **balanced-match 1.0.2** — Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt
- **base64-js 1.5.1** — Copyright (c) 2014 Jameson Little
- **bluebird 3.4.7** — Copyright (c) 2013-2015 Petka Antonov
- **brace-expansion 2.1.2** — Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>
- **commander 7.2.0** — Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>
- **commander 8.3.0** — Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>
- **core-util-is 1.0.3** — Copyright Node.js contributors. All rights reserved
- **cose-base 1.0.3** — Copyright (c) 2019 - present, iVis@Bilkent
- **cose-base 2.2.0** — Copyright (c) 2019 - present, iVis@Bilkent
- **cytoscape 3.34.0** — Copyright (c) 2016-2026, The Cytoscape Consortium
- **cytoscape-cose-bilkent 4.1.0** — Copyright (c) 2016-2018, The Cytoscape Consortium
- **cytoscape-fcose 2.2.0** — Copyright (c) 2018 - present, iVis-at-Bilkent
- **dagre-d3-es 7.0.14** — Copyright (c) 2022-2024 Thibaut Lassalle, David Newell, Alois Klink, Sidharth Vinod and dagre-es contributors
- **dayjs 1.11.21** — Copyright (c) 2018-present, iamkun
- **dequal 2.0.3** — Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)
- **devlop 1.1.0** — Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>
- **es-toolkit 1.49.0** — Copyright (c) 2024 Viva Republica, Inc
- **fast-deep-equal 3.1.3** — Copyright (c) 2017 Evgeny Poberezkin
- **hachure-fill 0.5.2** — Copyright (c) 2023 Preet Shihn
- **iconv-lite 0.6.3** — Copyright (c) 2011 Alexander Shtuchkin
- **immediate 3.0.6** — Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier
- **import-meta-resolve 4.2.0** — Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>; Copyright Node.js contributors. All rights reserved; Copyright Joyent, Inc. and other Node contributors. All rights reserved
- **isarray 1.0.0** — Copyright Julian Gruber (per package manifest; the distributed license file carries no copyright line)
- **jsonc-parser 3.3.1** — Copyright (c) Microsoft
- **jszip 3.10.1** — Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso
- **katex 0.16.47** — Copyright (c) 2013-2020 Khan Academy and other contributors
- **khroma 2.1.0** — Copyright (c) 2019-present Fabio Spampinato, Andrew Maney
- **layout-base 1.0.2** — Copyright (c) 2019 iVis@Bilkent
- **layout-base 2.0.1** — Copyright (c) 2019 iVis@Bilkent
- **lie 3.3.0** — no copyright line in the distributed license file
- **lodash-es 4.18.1** — Copyright OpenJS Foundation and other contributors <https://openjsf.org/>
- **lowlight 3.3.0** — Copyright (c) Titus Wormer <tituswormer@gmail.com>
- **marked 14.0.0** — Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber
- **marked 16.4.2** — Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber
- **marked 18.0.6** — Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber
- **material-icon-theme 5.36.1** — Copyright (c) 2025 Material Extensions
- **mermaid 11.16.0** — Copyright (c) 2014 - 2022 Knut Sveidqvist
- **monaco-editor 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **monaco-languageclient 10.7.0** — Copyright 2018 - present TypeFox GmbH
- **package-manager-detector 1.7.0** — Copyright (c) 2020-PRESENT Anthony Fu <https://github.com/antfu>
- **path-data-parser 0.1.0** — Copyright (c) 2020 Preet Shihn
- **path-is-absolute 1.0.1** — Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
- **points-on-curve 0.2.0** — Copyright (c) 2020 Preet Shihn
- **points-on-path 0.2.1** — Copyright (c) 2020 Preet
- **process-nextick-args 2.0.1** — no copyright line in the distributed license file
- **react 19.2.7** — Copyright (c) Meta Platforms, Inc. and affiliates
- **react-dom 19.2.7** — Copyright (c) Meta Platforms, Inc. and affiliates
- **react-resizable-panels 2.1.9** — Copyright (c) 2023 Brian Vaughn
- **reactivity-store 0.4.0** — Copyright (c) 2022 MrWangJustToDo
- **readable-stream 2.3.8** — Copyright Node.js contributors. All rights reserved; Copyright Joyent, Inc. and other Node contributors. All rights reserved
- **roughjs 4.6.6** — Copyright (c) 2019 Preet Shihn
- **safe-buffer 5.1.2** — Copyright (c) Feross Aboukhadijeh
- **safer-buffer 2.1.2** — Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com>
- **scheduler 0.27.0** — Copyright (c) Meta Platforms, Inc. and affiliates
- **setimmediate 1.0.5** — Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, and Domenic Denicola
- **string_decoder 1.1.1** — Copyright Node.js contributors. All rights reserved; Copyright Joyent, Inc. and other Node contributors. All rights reserved
- **stylis 4.4.0** — Copyright (c) 2016-present Sultan Tarimo
- **tinyexec 1.2.4** — Copyright (c) 2024 Tinylibs
- **ts-dedent 2.3.0** — Copyright (c) 2018 Tamino Martinius
- **underscore 1.13.8** — Copyright (c) 2009-2022 Jeremy Ashkenas, Julian Gonggrijp, and DocumentCloud and Investigative Reporters & Editors
- **use-sync-external-store 1.6.0** — Copyright (c) Meta Platforms, Inc. and affiliates
- **util-deprecate 1.0.2** — Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>
- **uuid 14.0.1** — Copyright (c) 2010-2020 Robert Kieffer and other contributors
- **vscode 25.1.2** — Copyright CodinGame (per package manifest; the distributed license file carries no copyright line)
- **vscode-jsonrpc 8.2.0** — Copyright (c) Microsoft Corporation
- **vscode-jsonrpc 8.2.1** — Copyright (c) Microsoft Corporation
- **vscode-languageclient 9.0.1** — Copyright (c) Microsoft Corporation
- **vscode-languageserver-protocol 3.17.5** — Copyright (c) Microsoft Corporation
- **vscode-languageserver-types 3.17.5** — Copyright (c) Microsoft Corporation
- **vscode-ws-jsonrpc 3.5.0** — Copyright 2018 - present TypeFox GmbH
- **xmlbuilder 10.1.1** — Copyright (c) 2013 Ozgur Ozcitak

### ISC — 36

- **d3 7.9.0** — Copyright 2010-2023 Mike Bostock
- **d3-array 3.2.4** — Copyright 2010-2023 Mike Bostock
- **d3-axis 3.0.0** — Copyright 2010-2021 Mike Bostock
- **d3-brush 3.0.0** — Copyright 2010-2021 Mike Bostock
- **d3-chord 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-color 3.1.0** — Copyright 2010-2022 Mike Bostock
- **d3-contour 4.0.2** — Copyright 2012-2023 Mike Bostock
- **d3-delaunay 6.0.4** — Copyright 2018-2021 Observable, Inc; Copyright 2021 Mapbox
- **d3-dispatch 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-drag 3.0.0** — Copyright 2010-2021 Mike Bostock
- **d3-dsv 3.0.1** — Copyright 2013-2021 Mike Bostock
- **d3-fetch 3.0.1** — Copyright 2016-2021 Mike Bostock
- **d3-force 3.0.0** — Copyright 2010-2021 Mike Bostock
- **d3-format 3.1.2** — Copyright 2010-2026 Mike Bostock
- **d3-geo 3.1.1** — Copyright 2010-2024 Mike Bostock; Copyright 2008-2012 Charles Karney
- **d3-hierarchy 3.1.2** — Copyright 2010-2021 Mike Bostock
- **d3-interpolate 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-path 3.1.0** — Copyright 2015-2022 Mike Bostock
- **d3-polygon 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-quadtree 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-random 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-scale 4.0.2** — Copyright 2010-2021 Mike Bostock
- **d3-scale-chromatic 3.1.0** — Copyright 2010-2024 Mike Bostock; Copyright 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University
- **d3-selection 3.0.0** — Copyright 2010-2021 Mike Bostock
- **d3-shape 3.2.0** — Copyright 2010-2022 Mike Bostock
- **d3-time 3.1.0** — Copyright 2010-2022 Mike Bostock
- **d3-time-format 4.1.0** — Copyright 2010-2021 Mike Bostock
- **d3-timer 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-transition 3.0.1** — Copyright 2010-2021 Mike Bostock
- **d3-zoom 3.0.0** — Copyright 2010-2021 Mike Bostock
- **delaunator 5.1.0** — Copyright (c) 2026, Mapbox
- **inherits 2.0.4** — Copyright (c) Isaac Z. Schlueter
- **internmap 1.0.1** — Copyright 2021 Mike Bostock
- **internmap 2.0.3** — Copyright 2021 Mike Bostock
- **minimatch 5.1.9** — Copyright (c) 2011-2023 Isaac Z. Schlueter and Contributors
- **semver 7.8.5** — Copyright (c) Isaac Z. Schlueter and Contributors

### BSD-3-Clause — 9

- **d3-array 2.12.1** — Copyright 2010-2020 Mike Bostock
- **d3-ease 3.0.1** — Copyright 2010-2021 Mike Bostock; Copyright 2001 Robert Penner
- **d3-path 1.0.9** — Copyright 2015-2016 Mike Bostock
- **d3-sankey 0.12.3** — Copyright 2015, Mike Bostock
- **d3-shape 1.3.7** — Copyright 2010-2015 Mike Bostock
- **diff 8.0.4** — Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
- **highlight.js 11.11.1** — Copyright (c) 2006, Ivan Sagalaev
- **rw 1.3.3** — Copyright (c) 2014-2016, Michael Bostock
- **sprintf-js 1.0.3** — Copyright (c) 2007-2014, Alexandru Marasteanu <hello [at) alexei (dot] ro>

### Apache-2.0 — 5

- **@chevrotain/types 11.1.2** — Copyright Shahar Soel (per package manifest; the distributed license file carries no copyright line)
- **dompurify 3.3.1** — Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53
- **dompurify 3.4.12** — Copyright Dr.-Ing. Mario Heiderich, Cure53 (per package manifest; the distributed license file carries no copyright line)
- **fast-diff 1.3.0** — Copyright Jason Chen (per package manifest; the distributed license file carries no copyright line)
- **xlsx 0.20.3** — Copyright sheetjs (per package manifest; the distributed license file carries no copyright line)

### BSD-2-Clause — 5

- **dingbat-to-unicode 1.0.1** — Copyright Michael Williamson (per package manifest; the distributed license file carries no copyright line)
- **duck 0.1.12** — Copyright (c) 2013, Michael Williamson
- **lop 0.4.2** — Copyright (c) 2013, Michael Williamson
- **mammoth 1.12.0** — Copyright (c) 2013, Michael Williamson
- **option 0.2.4** — Copyright (c) 2013, Michael Williamson

### OFL-1.1 — 3

- **@fontsource-variable/archivo 5.3.0** — Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) Archivo-Italic[wdth,wght].ttf: Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)
- **@fontsource-variable/jetbrains-mono 5.3.0** — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- **@fontsource/vt323 5.3.0** — Copyright 2011, The VT323 Project Authors (peter.hull@oikoi.com)

### BSD-3-Clause AND Apache-2.0 — 1

- **chroma-js 3.2.0** — Copyright (c) 2011-2025, Gregor Aisch; Copyright (c) 2002 Cynthia Brewer, Mark Harrower

### LGPL-2.1-or-later — 1

- **jschardet 3.1.4** — Copyright António Afonso (per package manifest; the distributed license file carries no copyright line)

### MIT AND Zlib — 1

- **pako 1.0.11** — Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

### Unlicense — 1

- **robust-predicates 3.0.3** — Copyright Vladimir Agafonkin (per package manifest; the distributed license file carries no copyright line)

## License texts

### Apache-2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright (C) 2012-present   SheetJS LLC

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### Apache-2.0 WITH LLVM-exception

```

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.


--- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.
```

### BSD-2-Clause

```
BSD 2-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD-3-Clause

```
BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### CC0-1.0

```
Creative Commons CC0 1.0 Universal

<<beginOptional;name=ccOptionalIntro>> CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE LEGAL SERVICES. DISTRIBUTION OF THIS DOCUMENT DOES NOT CREATE AN ATTORNEY-CLIENT RELATIONSHIP. CREATIVE COMMONS PROVIDES THIS INFORMATION ON AN "AS-IS" BASIS. CREATIVE COMMONS MAKES NO WARRANTIES REGARDING THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED HEREUNDER, AND DISCLAIMS LIABILITY FOR DAMAGES RESULTING FROM THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED HEREUNDER.  <<endOptional>>

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer exclusive Copyright and Related Rights (defined below) upon the creator and subsequent owner(s) (each and all, an "owner") of an original work of authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for the purpose of contributing to a commons of creative, cultural and scientific works ("Commons") that the public can reliably and without fear of later claims of infringement build upon, modify, incorporate in other works, reuse and redistribute as freely as possible in any form whatsoever and for any purposes, including without limitation commercial purposes. These owners may contribute to the Commons to promote the ideal of a free culture and the further production of creative, cultural and scientific works, or to gain reputation or greater distribution for their Work in part through the use and efforts of others.

For these and/or other purposes and motivations, and without any expectation of additional consideration or compensation, the person associating CC0 with a Work (the "Affirmer"), to the extent that he or she is an owner of Copyright and Related Rights in the Work, voluntarily elects to apply CC0 to the Work and publicly distribute the Work under its terms, with knowledge of his or her Copyright and Related Rights in the Work and the meaning and intended legal effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be protected by copyright and related or neighboring rights ("Copyright and Related Rights"). Copyright and Related Rights include, but are not limited to, the following:

     i. the right to reproduce, adapt, distribute, perform, display, communicate, and translate a Work;

     ii. moral rights retained by the original author(s) and/or performer(s);

     iii. publicity and privacy rights pertaining to a person's image or likeness depicted in a Work;

     iv. rights protecting against unfair competition in regards to a Work, subject to the limitations in paragraph 4(a), below;

     v. rights protecting the extraction, dissemination, use and reuse of data in a Work;

     vi. database rights (such as those arising under Directive 96/9/EC of the European Parliament and of the Council of 11 March 1996 on the legal protection of databases, and under any national implementation thereof, including any amended or successor version of such directive); and

     vii. other similar, equivalent or corresponding rights throughout the world based on applicable law or treaty, and any national implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention of, applicable law, Affirmer hereby overtly, fully, permanently, irrevocably and unconditionally waives, abandons, and surrenders all of Affirmer's Copyright and Related Rights and associated claims and causes of action, whether now known or unknown (including existing as well as future claims and causes of action), in the Work (i) in all territories worldwide, (ii) for the maximum duration provided by applicable law or treaty (including future time extensions), (iii) in any current or future medium and for any number of copies, and (iv) for any purpose whatsoever, including without limitation commercial, advertising or promotional purposes (the "Waiver"). Affirmer makes the Waiver for the benefit of each member of the public at large and to the detriment of Affirmer's heirs and successors, fully intending that such Waiver shall not be subject to revocation, rescission, cancellation, termination, or any other legal or equitable action to disrupt the quiet enjoyment of the Work by the public as contemplated by Affirmer's express Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason be judged legally invalid or ineffective under applicable law, then the Waiver shall be preserved to the maximum extent permitted taking into account Affirmer's express Statement of Purpose. In addition, to the extent the Waiver is so judged Affirmer hereby grants to each affected person a royalty-free, non transferable, non sublicensable, non exclusive, irrevocable and unconditional license to exercise Affirmer's Copyright and Related Rights in the Work (i) in all territories worldwide, (ii) for the maximum duration provided by applicable law or treaty (including future time extensions), (iii) in any current or future medium and for any number of copies, and (iv) for any purpose whatsoever, including without limitation commercial, advertising or promotional purposes (the "License"). The License shall be deemed effective as of the date CC0 was applied by Affirmer to the Work. Should any part of the License for any reason be judged legally invalid or ineffective under applicable law, such partial invalidity or ineffectiveness shall not invalidate the remainder of the License, and in such case Affirmer hereby affirms that he or she will not (i) exercise any of his or her remaining Copyright and Related Rights in the Work or (ii) assert any associated claims and causes of action with respect to the Work, in either case contrary to Affirmer's express Statement of Purpose.

4. Limitations and Disclaimers.

     a. No trademark or patent rights held by Affirmer are waived, abandoned, surrendered, licensed or otherwise affected by this document.

     b. Affirmer offers the Work as-is and makes no representations or warranties of any kind concerning the Work, express, implied, statutory or otherwise, including without limitation warranties of title, merchantability, fitness for a particular purpose, non infringement, or the absence of latent or other defects, accuracy, or the present or absence of errors, whether or not discoverable, all to the greatest extent permissible under applicable law.

     c. Affirmer disclaims responsibility for clearing rights of other persons that may apply to the Work or any use thereof, including without limitation any person's Copyright and Related Rights in the Work. Further, Affirmer disclaims responsibility for obtaining any necessary consents, permissions or other rights required for any use of the Work.

     d. Affirmer understands and acknowledges that Creative Commons is not a party to this document and has no duty or obligation with respect to this CC0 or use of the Work.
```

### CDLA-Permissive-2.0

```
# Community Data License Agreement - Permissive - Version 2.0

This is the Community Data License Agreement - Permissive, Version
2.0 (the "agreement"). Data Provider(s) and Data Recipient(s) agree
as follows:

## 1. Provision of the Data

1.1. A Data Recipient may use, modify, and share the Data made
available by Data Provider(s) under this agreement if that Data
Recipient follows the terms of this agreement.

1.2. This agreement does not impose any restriction on a Data
Recipient's use, modification, or sharing of any portions of the
Data that are in the public domain or that may be used, modified,
or shared under any other legal exception or limitation.

## 2. Conditions for Sharing Data

2.1. A Data Recipient may share Data, with or without modifications, so
long as the Data Recipient makes available the text of this agreement
with the shared Data.

## 3. No Restrictions on Results

3.1. This agreement does not impose any restriction or obligations
with respect to the use, modification, or sharing of Results.

## 4. No Warranty; Limitation of Liability

4.1. All Data Recipients receive the Data subject to the following
terms:

THE DATA IS PROVIDED ON AN "AS IS" BASIS, WITHOUT REPRESENTATIONS,
WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED
INCLUDING, WITHOUT LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE,
NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

NO DATA PROVIDER SHALL HAVE ANY LIABILITY FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING
WITHOUT LIMITATION LOST PROFITS), HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE DATA OR RESULTS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

## 5. Definitions

5.1. "Data" means the material received by a Data Recipient under
this agreement.

5.2. "Data Provider" means any person who is the source of Data
provided under this agreement and in reliance on a Data Recipient's
agreement to its terms.

5.3. "Data Recipient" means any person who receives Data directly
or indirectly from a Data Provider and agrees to the terms of this
agreement.

5.4. "Results" means any outcome obtained by computational analysis
of Data, including for example machine learning models and models'
insights.
```

### ISC

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### LGPL-2.1-or-later

```
                  GNU LESSER GENERAL PUBLIC LICENSE
                       Version 2.1, February 1999

 Copyright (C) 1991, 1999 Free Software Foundation, Inc.
 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

(This is the first released version of the Lesser GPL.  It also counts
 as the successor of the GNU Library Public License, version 2, hence
 the version number 2.1.)

                            Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
Licenses are intended to guarantee your freedom to share and change
free software--to make sure the software is free for all its users.

  This license, the Lesser General Public License, applies to some
specially designated software packages--typically libraries--of the
Free Software Foundation and other authors who decide to use it.  You
can use it too, but we suggest you first think carefully about whether
this license or the ordinary General Public License is the better
strategy to use in any particular case, based on the explanations below.

  When we speak of free software, we are referring to freedom of use,
not price.  Our General Public Licenses are designed to make sure that
you have the freedom to distribute copies of free software (and charge
for this service if you wish); that you receive source code or can get
it if you want it; that you can change the software and use pieces of
it in new free programs; and that you are informed that you can do
these things.

  To protect your rights, we need to make restrictions that forbid
distributors to deny you these rights or to ask you to surrender these
rights.  These restrictions translate to certain responsibilities for
you if you distribute copies of the library or if you modify it.

  For example, if you distribute copies of the library, whether gratis
or for a fee, you must give the recipients all the rights that we gave
you.  You must make sure that they, too, receive or can get the source
code.  If you link other code with the library, you must provide
complete object files to the recipients, so that they can relink them
with the library after making changes to the library and recompiling
it.  And you must show them these terms so they know their rights.

  We protect your rights with a two-step method: (1) we copyright the
library, and (2) we offer you this license, which gives you legal
permission to copy, distribute and/or modify the library.

  To protect each distributor, we want to make it very clear that
there is no warranty for the free library.  Also, if the library is
modified by someone else and passed on, the recipients should know
that what they have is not the original version, so that the original
author's reputation will not be affected by problems that might be
introduced by others.

  Finally, software patents pose a constant threat to the existence of
any free program.  We wish to make sure that a company cannot
effectively restrict the users of a free program by obtaining a
restrictive license from a patent holder.  Therefore, we insist that
any patent license obtained for a version of the library must be
consistent with the full freedom of use specified in this license.

  Most GNU software, including some libraries, is covered by the
ordinary GNU General Public License.  This license, the GNU Lesser
General Public License, applies to certain designated libraries, and
is quite different from the ordinary General Public License.  We use
this license for certain libraries in order to permit linking those
libraries into non-free programs.

  When a program is linked with a library, whether statically or using
a shared library, the combination of the two is legally speaking a
combined work, a derivative of the original library.  The ordinary
General Public License therefore permits such linking only if the
entire combination fits its criteria of freedom.  The Lesser General
Public License permits more lax criteria for linking other code with
the library.

  We call this license the "Lesser" General Public License because it
does Less to protect the user's freedom than the ordinary General
Public License.  It also provides other free software developers Less
of an advantage over competing non-free programs.  These disadvantages
are the reason we use the ordinary General Public License for many
libraries.  However, the Lesser license provides advantages in certain
special circumstances.

  For example, on rare occasions, there may be a special need to
encourage the widest possible use of a certain library, so that it becomes
a de-facto standard.  To achieve this, non-free programs must be
allowed to use the library.  A more frequent case is that a free
library does the same job as widely used non-free libraries.  In this
case, there is little to gain by limiting the free library to free
software only, so we use the Lesser General Public License.

  In other cases, permission to use a particular library in non-free
programs enables a greater number of people to use a large body of
free software.  For example, permission to use the GNU C Library in
non-free programs enables many more people to use the whole GNU
operating system, as well as its variant, the GNU/Linux operating
system.

  Although the Lesser General Public License is Less protective of the
users' freedom, it does ensure that the user of a program that is
linked with the Library has the freedom and the wherewithal to run
that program using a modified version of the Library.

  The precise terms and conditions for copying, distribution and
modification follow.  Pay close attention to the difference between a
"work based on the library" and a "work that uses the library".  The
former contains code derived from the library, whereas the latter must
be combined with the library in order to run.

                  GNU LESSER GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License Agreement applies to any software library or other
program which contains a notice placed by the copyright holder or
other authorized party saying it may be distributed under the terms of
this Lesser General Public License (also called "this License").
Each licensee is addressed as "you".

  A "library" means a collection of software functions and/or data
prepared so as to be conveniently linked with application programs
(which use some of those functions and data) to form executables.

  The "Library", below, refers to any such software library or work
which has been distributed under these terms.  A "work based on the
Library" means either the Library or any derivative work under
copyright law: that is to say, a work containing the Library or a
portion of it, either verbatim or with modifications and/or translated
straightforwardly into another language.  (Hereinafter, translation is
included without limitation in the term "modification".)

  "Source code" for a work means the preferred form of the work for
making modifications to it.  For a library, complete source code means
all the source code for all modules it contains, plus any associated
interface definition files, plus the scripts used to control compilation
and installation of the library.

  Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running a program using the Library is not restricted, and output from
such a program is covered only if its contents constitute a work based
on the Library (independent of the use of the Library in a tool for
writing it).  Whether that is true depends on what the Library does
and what the program that uses the Library does.

  1. You may copy and distribute verbatim copies of the Library's
complete source code as you receive it, in any medium, provided that
you conspicuously and appropriately publish on each copy an
appropriate copyright notice and disclaimer of warranty; keep intact
all the notices that refer to this License and to the absence of any
warranty; and distribute a copy of this License along with the
Library.

  You may charge a fee for the physical act of transferring a copy,
and you may at your option offer warranty protection in exchange for a
fee.

  2. You may modify your copy or copies of the Library or any portion
of it, thus forming a work based on the Library, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) The modified work must itself be a software library.

    b) You must cause the files modified to carry prominent notices
    stating that you changed the files and the date of any change.

    c) You must cause the whole of the work to be licensed at no
    charge to all third parties under the terms of this License.

    d) If a facility in the modified Library refers to a function or a
    table of data to be supplied by an application program that uses
    the facility, other than as an argument passed when the facility
    is invoked, then you must make a good faith effort to ensure that,
    in the event an application does not supply such function or
    table, the facility still operates, and performs whatever part of
    its purpose remains meaningful.

    (For example, a function in a library to compute square roots has
    a purpose that is entirely well-defined independent of the
    application.  Therefore, Subsection 2d requires that any
    application-supplied function or table used by this function must
    be optional: if the application does not supply it, the square
    root function must still compute square roots.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Library,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Library, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote
it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Library.

In addition, mere aggregation of another work not based on the Library
with the Library (or with a work based on the Library) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may opt to apply the terms of the ordinary GNU General Public
License instead of this License to a given copy of the Library.  To do
this, you must alter all the notices that refer to this License, so
that they refer to the ordinary GNU General Public License, version 2,
instead of to this License.  (If a newer version than version 2 of the
ordinary GNU General Public License has appeared, then you can specify
that version instead if you wish.)  Do not make any other change in
these notices.

  Once this change is made in a given copy, it is irreversible for
that copy, so the ordinary GNU General Public License applies to all
subsequent copies and derivative works made from that copy.

  This option is useful when you wish to copy part of the code of
the Library into a program that is not a library.

  4. You may copy and distribute the Library (or a portion or
derivative of it, under Section 2) in object code or executable form
under the terms of Sections 1 and 2 above provided that you accompany
it with the complete corresponding machine-readable source code, which
must be distributed under the terms of Sections 1 and 2 above on a
medium customarily used for software interchange.

  If distribution of object code is made by offering access to copy
from a designated place, then offering equivalent access to copy the
source code from the same place satisfies the requirement to
distribute the source code, even though third parties are not
compelled to copy the source along with the object code.

  5. A program that contains no derivative of any portion of the
Library, but is designed to work with the Library by being compiled or
linked with it, is called a "work that uses the Library".  Such a
work, in isolation, is not a derivative work of the Library, and
therefore falls outside the scope of this License.

  However, linking a "work that uses the Library" with the Library
creates an executable that is a derivative of the Library (because it
contains portions of the Library), rather than a "work that uses the
library".  The executable is therefore covered by this License.
Section 6 states terms for distribution of such executables.

  When a "work that uses the Library" uses material from a header file
that is part of the Library, the object code for the work may be a
derivative work of the Library even though the source code is not.
Whether this is true is especially significant if the work can be
linked without the Library, or if the work is itself a library.  The
threshold for this to be true is not precisely defined by law.

  If such an object file uses only numerical parameters, data
structure layouts and accessors, and small macros and small inline
functions (ten lines or less in length), then the use of the object
file is unrestricted, regardless of whether it is legally a derivative
work.  (Executables containing this object code plus portions of the
Library will still fall under Section 6.)

  Otherwise, if the work is a derivative of the Library, you may
distribute the object code for the work under the terms of Section 6.
Any executables containing that work also fall under Section 6,
whether or not they are linked directly with the Library itself.

  6. As an exception to the Sections above, you may also combine or
link a "work that uses the Library" with the Library to produce a
work containing portions of the Library, and distribute that work
under terms of your choice, provided that the terms permit
modification of the work for the customer's own use and reverse
engineering for debugging such modifications.

  You must give prominent notice with each copy of the work that the
Library is used in it and that the Library and its use are covered by
this License.  You must supply a copy of this License.  If the work
during execution displays copyright notices, you must include the
copyright notice for the Library among them, as well as a reference
directing the user to the copy of this License.  Also, you must do one
of these things:

    a) Accompany the work with the complete corresponding
    machine-readable source code for the Library including whatever
    changes were used in the work (which must be distributed under
    Sections 1 and 2 above); and, if the work is an executable linked
    with the Library, with the complete machine-readable "work that
    uses the Library", as object code and/or source code, so that the
    user can modify the Library and then relink to produce a modified
    executable containing the modified Library.  (It is understood
    that the user who changes the contents of definitions files in the
    Library will not necessarily be able to recompile the application
    to use the modified definitions.)

    b) Use a suitable shared library mechanism for linking with the
    Library.  A suitable mechanism is one that (1) uses at run time a
    copy of the library already present on the user's computer system,
    rather than copying library functions into the executable, and (2)
    will operate properly with a modified version of the library, if
    the user installs one, as long as the modified version is
    interface-compatible with the version that the work was made with.

    c) Accompany the work with a written offer, valid for at
    least three years, to give the same user the materials
    specified in Subsection 6a, above, for a charge no more
    than the cost of performing this distribution.

    d) If distribution of the work is made by offering access to copy
    from a designated place, offer equivalent access to copy the above
    specified materials from the same place.

    e) Verify that the user has already received a copy of these
    materials or that you have already sent this user a copy.

  For an executable, the required form of the "work that uses the
Library" must include any data and utility programs needed for
reproducing the executable from it.  However, as a special exception,
the materials to be distributed need not include anything that is
normally distributed (in either source or binary form) with the major
components (compiler, kernel, and so on) of the operating system on
which the executable runs, unless that component itself accompanies
the executable.

  It may happen that this requirement contradicts the license
restrictions of other proprietary libraries that do not normally
accompany the operating system.  Such a contradiction means you cannot
use both them and the Library together in an executable that you
distribute.

  7. You may place library facilities that are a work based on the
Library side-by-side in a single library together with other library
facilities not covered by this License, and distribute such a combined
library, provided that the separate distribution of the work based on
the Library and of the other library facilities is otherwise
permitted, and provided that you do these two things:

    a) Accompany the combined library with a copy of the same work
    based on the Library, uncombined with any other library
    facilities.  This must be distributed under the terms of the
    Sections above.

    b) Give prominent notice with the combined library of the fact
    that part of it is a work based on the Library, and explaining
    where to find the accompanying uncombined form of the same work.

  8. You may not copy, modify, sublicense, link with, or distribute
the Library except as expressly provided under this License.  Any
attempt otherwise to copy, modify, sublicense, link with, or
distribute the Library is void, and will automatically terminate your
rights under this License.  However, parties who have received copies,
or rights, from you under this License will not have their licenses
terminated so long as such parties remain in full compliance.

  9. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Library or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Library (or any work based on the
Library), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Library or works based on it.

  10. Each time you redistribute the Library (or any work based on the
Library), the recipient automatically receives a license from the
original licensor to copy, distribute, link with or modify the Library
subject to these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties with
this License.

  11. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Library at all.  For example, if a patent
license would not permit royalty-free redistribution of the Library by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Library.

If any portion of this section is held invalid or unenforceable under any
particular circumstance, the balance of the section is intended to apply,
and the section as a whole is intended to apply in other circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  12. If the distribution and/or use of the Library is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Library under this License may add
an explicit geographical distribution limitation excluding those countries,
so that distribution is permitted only in or among countries not thus
excluded.  In such case, this License incorporates the limitation as if
written in the body of this License.

  13. The Free Software Foundation may publish revised and/or new
versions of the Lesser General Public License from time to time.
Such new versions will be similar in spirit to the present version,
but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Library
specifies a version number of this License which applies to it and
"any later version", you have the option of following the terms and
conditions either of that version or of any later version published by
the Free Software Foundation.  If the Library does not specify a
license version number, you may choose any version ever published by
the Free Software Foundation.

  14. If you wish to incorporate parts of the Library into other free
programs whose distribution conditions are incompatible with these,
write to the author to ask for permission.  For software which is
copyrighted by the Free Software Foundation, write to the Free
Software Foundation; we sometimes make exceptions for this.  Our
decision will be guided by the two goals of preserving the free status
of all derivatives of our free software and of promoting the sharing
and reuse of software generally.

                            NO WARRANTY

  15. BECAUSE THE LIBRARY IS LICENSED FREE OF CHARGE, THERE IS NO
WARRANTY FOR THE LIBRARY, TO THE EXTENT PERMITTED BY APPLICABLE LAW.
EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR
OTHER PARTIES PROVIDE THE LIBRARY "AS IS" WITHOUT WARRANTY OF ANY
KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE
LIBRARY IS WITH YOU.  SHOULD THE LIBRARY PROVE DEFECTIVE, YOU ASSUME
THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

  16. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY
AND/OR REDISTRIBUTE THE LIBRARY AS PERMITTED ABOVE, BE LIABLE TO YOU
FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE
LIBRARY (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A
FAILURE OF THE LIBRARY TO OPERATE WITH ANY OTHER SOFTWARE), EVEN IF
SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

                     END OF TERMS AND CONDITIONS

           How to Apply These Terms to Your New Libraries

  If you develop a new library, and you want it to be of the greatest
possible use to the public, we recommend making it free software that
everyone can redistribute and change.  You can do so by permitting
redistribution under these terms (or, alternatively, under the terms of the
ordinary General Public License).

  To apply these terms, attach the following notices to the library.  It is
safest to attach them to the start of each source file to most effectively
convey the exclusion of warranty; and each file should have at least the
"copyright" line and a pointer to where the full notice is found.

    {description}
    Copyright (C) {year} {fullname}

    This library is free software; you can redistribute it and/or
    modify it under the terms of the GNU Lesser General Public
    License as published by the Free Software Foundation; either
    version 2.1 of the License, or (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
    Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public
    License along with this library; if not, write to the Free Software
    Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301
    USA

Also add information on how to contact you by electronic and paper mail.

You should also get your employer (if you work as a programmer) or your
school, if any, to sign a "copyright disclaimer" for the library, if
necessary.  Here is a sample; alter the names:

  Yoyodyne, Inc., hereby disclaims all copyright interest in the
  library `Frob' (a library for tweaking knobs) written by James Random
  Hacker.

  {signature of Ty Coon}, 1 April 1990
  Ty Coon, President of Vice

That's all there is to it!
```

### MIT

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT-0

```
MIT No Attribution

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MPL-2.0

```
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in 
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

### OFL-1.1

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### Unicode-3.0

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2020-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0

—

Portions of ICU4X may have been adapted from ICU4C and/or ICU4J.
ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.
```

### Unlicense

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

### Zlib

```
zlib License

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```
