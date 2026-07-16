# Third-party notices

Canopy itself is licensed under PolyForm Noncommercial 1.0.0 (see LICENSE.md).
The components below are licensed by their respective authors under the terms
listed here, and those terms — not Canopy's — govern their use.

This file is generated from the resolved dependency trees (`cargo metadata` and
node_modules), not maintained by hand.

## Notes on specific components

**jschardet (3.1.4) — LGPL-2.1-or-later.** Pulled in transitively by
`@codingame/monaco-vscode-api` for character-set detection, and included in the
distributed application. The LGPL permits this without affecting Canopy's own
license, provided users can replace the library with a modified version. Canopy
ships jschardet as its own separate JavaScript chunk (`assets/jschardet-*.js`)
rather than inlining it into the main bundle, so it can be substituted. Source:
<https://github.com/aadsm/jschardet>.

**Dual-licensed components.** Where a component offers a choice, Canopy takes
the permissive option: `jszip` under MIT (not GPL-3.0-or-later), `dompurify`
under Apache-2.0 (not MPL-2.0), and `r-efi` under MIT.

**MPL-2.0 components** (`cssparser`, `selectors`, `dtoa-short`, `option-ext`,
`lightningcss`) are file-level copyleft: obligations attach only to
modifications of those files, which Canopy does not make.

## Rust crates

### MIT OR Apache-2.0 (226)

android_log-sys@0.3.2, android_logger@0.15.1, anyhow@1.0.103, base64@0.21.7, base64@0.22.1, bitflags@2.13.1, block-buffer@0.10.4, bumpalo@3.20.3, camino@1.2.4, cargo-platform@0.1.9, cc@1.2.67, cfg-expr@0.15.8, cfg-if@1.0.4, chrono@0.4.45, cookie@0.18.1, core-foundation-sys@0.8.7, core-foundation@0.10.1, core-graphics-types@0.2.0, core-graphics@0.25.0, cpufeatures@0.2.17, crc32fast@1.5.0, crossbeam-channel@0.5.16, crossbeam-deque@0.8.7, crossbeam-epoch@0.9.20, crossbeam-utils@0.8.22, crypto-common@0.1.7, deranged@0.5.8, digest@0.10.7, dirs-sys@0.5.0, dirs@6.0.0, displaydoc@0.2.6, dtoa@1.0.11, dyn-clone@1.0.20, either@1.16.0, embed_plist@1.2.2, env_filter@0.1.4, erased-serde@0.4.10, fdeflate@0.3.7, field-offset@0.3.6, find-msvc-tools@0.1.9, flate2@1.1.9, form_urlencoded@1.2.2, futures-channel@0.3.32, futures-core@0.3.32, futures-executor@0.3.32, futures-io@0.3.32, futures-macro@0.3.32, futures-sink@0.3.32, futures-task@0.3.32, futures-util@0.3.32, getrandom@0.2.17, getrandom@0.3.4, getrandom@0.4.3, glob@0.3.3, hashbrown@0.12.3, hashbrown@0.17.1, heck@0.4.1, heck@0.5.0, hex@0.4.3, html5ever@0.38.0, http@1.4.2, httparse@1.10.1, iana-time-zone-haiku@0.1.2, iana-time-zone@0.1.65, idna@1.1.0, ipnet@2.12.0, itoa@1.0.18, jni-sys-macros@0.4.1, jni-sys@0.3.1, jni-sys@0.4.1, js-sys@0.3.103, jsonptr@0.6.3, keyboard-types@0.7.0, lazy_static@1.5.0, libc@0.2.186, lock_api@0.4.14, log@0.4.33, markup5ever@0.38.0, mime@0.3.17, ndk-sys@0.6.0+11769913, ndk@0.9.0, notify-types@2.1.0, num-conv@0.2.2, num-traits@0.2.19, num_threads@0.1.7, once_cell@1.21.4, parking_lot@0.12.5, parking_lot_core@0.9.12, percent-encoding@2.3.2, pkg-config@0.3.33, png@0.17.16, png@0.18.1, powerfmt@0.2.0, proc-macro-crate@1.3.1, proc-macro-crate@2.0.2, proc-macro-crate@3.5.0, proc-macro-error-attr@1.0.4, proc-macro-error@1.0.4, proc-macro2@1.0.106, quote@1.0.46, rayon-core@1.13.0, rayon@1.12.0, ref-cast-impl@1.0.25, ref-cast@1.0.25, regex-automata@0.4.16, regex-syntax@0.8.11, regex@1.13.1, reqwest@0.13.4, rustc_version@0.4.1, rustversion@1.0.23, scopeguard@1.2.0, semver@1.0.28, serde-untagged@0.1.9, serde@1.0.228, serde_core@1.0.228, serde_derive@1.0.228, serde_derive_internals@0.29.1, serde_json@1.0.150, serde_repr@0.1.20, serde_spanned@0.6.9, serde_spanned@1.1.1, serde_with@3.21.0, serde_with_macros@3.21.0, serialize-to-javascript-impl@0.1.2, serialize-to-javascript@0.1.2, servo_arc@0.4.3, sha2@0.10.9, shlex@2.0.1, smallvec@1.15.2, socket2@0.6.5, softbuffer@0.4.8, stable_deref_trait@1.2.1, string_cache@0.9.0, string_cache_codegen@0.6.1, swift-rs@1.0.7, syn@1.0.109, syn@2.0.119, system-deps@6.2.2, tao-macros@0.1.3, tendril@0.5.1, thiserror-impl@1.0.69, thiserror-impl@2.0.18, thiserror@1.0.69, thiserror@2.0.18, time-core@0.1.9, time-macros@0.2.31, time@0.3.53, toml@0.8.2, toml@0.9.12+spec-1.1.0, toml@1.1.3+spec-1.1.0, toml_datetime@0.6.3, toml_datetime@0.7.5+spec-1.1.0, toml_datetime@1.1.1+spec-1.1.0, toml_edit@0.19.15, toml_edit@0.20.2, toml_edit@0.25.13+spec-1.1.0, toml_parser@1.1.2+spec-1.1.0, toml_writer@1.1.2+spec-1.1.0, tray-icon@0.24.1, typeid@1.0.3, typenum@1.20.1, unicode-segmentation@1.13.3, url@2.5.8, wasm-bindgen-futures@0.4.76, wasm-bindgen-macro-support@0.2.126, wasm-bindgen-macro@0.2.126, wasm-bindgen-shared@0.2.126, wasm-bindgen@0.2.126, wasm-streams@0.5.0, web-sys@0.3.103, web_atoms@0.2.5, windows-collections@0.2.0, windows-core@0.56.0, windows-core@0.57.0, windows-core@0.61.2, windows-core@0.62.2, windows-future@0.2.1, windows-implement@0.56.0, windows-implement@0.57.0, windows-implement@0.60.2, windows-interface@0.56.0, windows-interface@0.57.0, windows-interface@0.59.3, windows-link@0.1.3, windows-link@0.2.1, windows-numerics@0.2.0, windows-result@0.1.2, windows-result@0.3.4, windows-result@0.4.1, windows-strings@0.4.2, windows-strings@0.5.1, windows-sys@0.45.0, windows-sys@0.59.0, windows-sys@0.60.2, windows-sys@0.61.2, windows-targets@0.42.2, windows-targets@0.52.6, windows-targets@0.53.5, windows-threading@0.1.0, windows-version@0.1.7, windows@0.56.0, windows@0.57.0, windows@0.61.3, windows_aarch64_gnullvm@0.42.2, windows_aarch64_gnullvm@0.52.6, windows_aarch64_gnullvm@0.53.1, windows_aarch64_msvc@0.42.2, windows_aarch64_msvc@0.52.6, windows_aarch64_msvc@0.53.1, windows_i686_gnu@0.42.2, windows_i686_gnu@0.52.6, windows_i686_gnu@0.53.1, windows_i686_gnullvm@0.52.6, windows_i686_gnullvm@0.53.1, windows_i686_msvc@0.42.2, windows_i686_msvc@0.52.6, windows_i686_msvc@0.53.1, windows_x86_64_gnu@0.42.2, windows_x86_64_gnu@0.52.6, windows_x86_64_gnu@0.53.1, windows_x86_64_gnullvm@0.42.2, windows_x86_64_gnullvm@0.52.6, windows_x86_64_gnullvm@0.53.1, windows_x86_64_msvc@0.42.2, windows_x86_64_msvc@0.52.6, windows_x86_64_msvc@0.53.1

### MIT (113)

atk-sys@0.18.2, atk@0.18.2, block2@0.6.2, bytes@1.12.1, cairo-rs@0.18.5, cairo-sys-rs@0.18.2, canopy@0.1.0, cargo_metadata@0.19.2, cfb@0.7.3, cfg_aliases@0.1.1, combine@4.6.7, darling@0.23.0, darling_core@0.23.0, darling_macro@0.23.0, derive_more-impl@2.1.1, derive_more@2.1.1, dlopen2@0.8.2, dlopen2_derive@0.4.3, dom_query@0.27.0, embed-resource@3.0.11, fern@0.7.1, filedescriptor@0.8.3, fsevent-sys@4.1.0, gdk-pixbuf-sys@0.18.0, gdk-pixbuf@0.18.5, gdk-sys@0.18.2, gdk@0.18.2, gdkwayland-sys@0.18.2, gdkx11-sys@0.18.2, gdkx11@0.18.2, generic-array@0.14.7, gio-sys@0.18.1, gio@0.18.4, glib-macros@0.18.5, glib-sys@0.18.1, glib@0.18.5, gobject-sys@0.18.0, gtk-sys@0.18.2, gtk3-macros@0.18.2, gtk@0.18.2, http-body-util@0.1.4, http-body@1.1.0, hyper-util@0.1.20, hyper@1.10.1, ico@0.5.0, infer@0.19.0, javascriptcore-rs-sys@1.1.1, javascriptcore-rs@1.1.2, kqueue-sys@1.1.2, kqueue@1.2.0, libredox@0.1.18, memoffset@0.9.1, mio@1.2.2, new_debug_unreachable@1.0.6, nix@0.28.0, objc2-encode@4.1.0, objc2-foundation@0.3.2, objc2@0.6.4, pango-sys@0.18.0, pango@0.18.3, phf@0.13.1, phf_codegen@0.13.1, phf_generator@0.13.1, phf_macros@0.13.1, phf_shared@0.13.1, plist@1.10.0, portable-pty@0.9.0, precomputed-hash@0.1.1, quick-xml@0.41.0, redox_syscall@0.5.18, redox_users@0.5.2, rfd@0.16.0, schemars@0.8.22, schemars@0.9.0, schemars@1.2.1, schemars_derive@0.8.22, simd-adler32@0.3.10, slab@0.4.12, soup3-sys@0.5.0, soup3@0.5.0, strsim@0.11.1, synstructure@0.13.2, sysinfo@0.33.1, tauri-winres@0.3.6, tokio-util@0.7.18, tokio@1.52.3, tower-http@0.6.11, tower-layer@0.3.3, tower-service@0.3.3, tower@0.5.3, tracing-core@0.1.36, tracing@0.1.44, trash@5.2.6, try-lock@0.2.5, urlencoding@2.1.3, urlpattern@0.3.0, version-compare@0.2.1, vswhom-sys@0.1.3, vswhom@0.1.0, want@0.3.1, webkit2gtk-sys@2.0.2, webkit2gtk@2.0.2, webview2-com-macros@0.8.1, webview2-com-sys@0.38.2, webview2-com@0.38.2, winnow@0.5.40, winnow@0.7.15, winnow@1.0.4, winreg@0.10.1, winreg@0.55.0, x11-dl@2.21.0, x11@2.21.0, zmij@1.0.23

### Apache-2.0 OR MIT (35)

atomic-waker@1.1.2, autocfg@1.5.1, bit-set@0.8.0, bit-vec@0.8.0, cargo_toml@0.22.3, ctor-proc-macro@0.0.7, ctor@0.8.0, dtor-proc-macro@0.0.6, dtor@0.3.0, equivalent@1.0.2, fastrand@2.4.1, idna_adapter@1.2.2, indexmap@1.9.3, indexmap@2.14.0, libappindicator-sys@0.9.0, libappindicator@0.9.0, muda@0.19.3, ntapi@0.4.3, pin-project-lite@0.2.17, rustc-hash@2.1.3, tauri-build@2.6.3, tauri-codegen@2.6.3, tauri-macros@2.6.3, tauri-plugin-dialog@2.7.1, tauri-plugin-fs@2.5.1, tauri-plugin-log@2.9.0, tauri-plugin@2.6.3, tauri-runtime-wry@2.11.4, tauri-runtime@2.11.3, tauri-utils@2.9.3, tauri@2.11.5, utf8_iter@1.0.4, uuid@1.24.0, window-vibrancy@0.6.0, wry@0.55.1

### MIT/Apache-2.0 (21)

android_system_properties@0.1.5, bitflags@1.3.2, bs58@0.5.1, downcast-rs@1.2.1, foreign-types-macros@0.2.3, foreign-types-shared@0.3.1, foreign-types@0.5.0, ident_case@1.0.1, jni@0.21.1, json-patch@3.0.1, shell-words@1.1.1, siphasher@1.0.3, unic-char-property@0.9.0, unic-char-range@0.9.0, unic-common@0.9.0, unic-ucd-ident@0.9.0, unic-ucd-version@0.9.0, version_check@0.9.5, winapi-i686-pc-windows-gnu@0.4.0, winapi-x86_64-pc-windows-gnu@0.4.0, winapi@0.3.9

### Unicode-3.0 (18)

icu_collections@2.2.0, icu_locale_core@2.2.0, icu_normalizer@2.2.0, icu_normalizer_data@2.2.0, icu_properties@2.2.0, icu_properties_data@2.2.0, icu_provider@2.2.0, litemap@0.8.2, potential_utf@0.1.5, tinystr@0.8.3, writeable@0.6.3, yoke-derive@0.8.2, yoke@0.8.3, zerofrom-derive@0.1.7, zerofrom@0.1.8, zerotrie@0.2.4, zerovec-derive@0.11.3, zerovec@0.11.6

### Zlib OR Apache-2.0 OR MIT (17)

bytemuck@1.25.1, dispatch2@0.3.1, objc2-app-kit@0.3.2, objc2-cloud-kit@0.3.2, objc2-core-data@0.3.2, objc2-core-foundation@0.3.2, objc2-core-graphics@0.3.2, objc2-core-image@0.3.2, objc2-core-location@0.3.2, objc2-core-text@0.3.2, objc2-exception-helper@0.1.1, objc2-io-surface@0.3.2, objc2-quartz-core@0.3.2, objc2-ui-kit@0.3.2, objc2-user-notifications@0.3.2, objc2-web-kit@0.3.2, tinyvec@1.12.0

### MPL-2.0 (5)

cssparser-macros@0.6.1, cssparser@0.36.0, dtoa-short@0.3.5, option-ext@0.2.0, selectors@0.36.1

### Apache-2.0/MIT (4)

cesu8@1.1.0, dbus@0.9.12, libdbus-sys@0.2.7, shared_library@0.1.9

### Unlicense OR MIT (4)

aho-corasick@1.1.4, byteorder@1.5.0, memchr@2.8.3, winapi-util@0.1.11

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (3)

wasi@0.11.1+wasi-snapshot-preview1, wasip2@1.0.4+wasi-0.2.12, wit-bindgen@0.57.1

### ISC (3)

inotify-sys@0.1.8, inotify@0.11.4, libloading@0.7.4

### Apache-2.0 (2)

sync_wrapper@1.0.2, tao@0.35.3

### BSD-3-Clause (2)

alloc-no-stdlib@2.0.4, alloc-stdlib@0.2.4

### BSD-3-Clause OR MIT OR Apache-2.0 (2)

num_enum@0.7.6, num_enum_derive@0.7.6

### MIT OR Apache-2.0 OR LGPL-2.1-or-later (2)

r-efi@5.3.0, r-efi@6.0.0

### MIT OR Apache-2.0 OR Zlib (2)

raw-window-handle@0.6.2, tinyvec_macros@0.1.1

### Unlicense/MIT (2)

same-file@1.0.6, walkdir@2.5.0

### (MIT OR Apache-2.0) AND Unicode-3.0 (1)

unicode-ident@1.0.24

### 0BSD OR MIT OR Apache-2.0 (1)

adler2@2.0.1

### Apache-2.0 / MIT (1)

fnv@1.0.7

### Apache-2.0 AND MIT (1)

dpi@0.1.2

### Apache-2.0 WITH LLVM-exception (1)

target-lexicon@0.12.16

### BSD-2-Clause OR Apache-2.0 (1)

serial2@0.2.37

### BSD-3-Clause AND MIT (1)

brotli@8.0.4

### BSD-3-Clause/MIT (1)

brotli-decompressor@5.0.3

### CC0-1.0 (1)

notify@8.2.0

### CC0-1.0 OR MIT-0 OR Apache-2.0 (1)

dunce@1.0.5

### MIT OR Zlib OR Apache-2.0 (1)

miniz_oxide@0.8.9

### Zlib (1)

foldhash@0.2.0

## npm packages

### MIT (177)

@antfu/install-pkg@1.1.0, @braintree/sanitize-url@7.1.2, @codingame/monaco-vscode-api@25.1.2, @codingame/monaco-vscode-base-service-override@25.1.2, @codingame/monaco-vscode-bulk-edit-service-override@25.1.2, @codingame/monaco-vscode-configuration-service-override@25.1.2, @codingame/monaco-vscode-editor-api@25.1.2, @codingame/monaco-vscode-editor-service-override@25.1.2, @codingame/monaco-vscode-environment-service-override@25.1.2, @codingame/monaco-vscode-extension-api@25.1.2, @codingame/monaco-vscode-extensions-service-override@25.1.2, @codingame/monaco-vscode-files-service-override@25.1.2, @codingame/monaco-vscode-host-service-override@25.1.2, @codingame/monaco-vscode-keybindings-service-override@25.1.2, @codingame/monaco-vscode-language-pack-cs@25.1.2, @codingame/monaco-vscode-language-pack-de@25.1.2, @codingame/monaco-vscode-language-pack-es@25.1.2, @codingame/monaco-vscode-language-pack-fr@25.1.2, @codingame/monaco-vscode-language-pack-it@25.1.2, @codingame/monaco-vscode-language-pack-ja@25.1.2, @codingame/monaco-vscode-language-pack-ko@25.1.2, @codingame/monaco-vscode-language-pack-pl@25.1.2, @codingame/monaco-vscode-language-pack-pt-br@25.1.2, @codingame/monaco-vscode-language-pack-qps-ploc@25.1.2, @codingame/monaco-vscode-language-pack-ru@25.1.2, @codingame/monaco-vscode-language-pack-tr@25.1.2, @codingame/monaco-vscode-language-pack-zh-hans@25.1.2, @codingame/monaco-vscode-language-pack-zh-hant@25.1.2, @codingame/monaco-vscode-languages-service-override@25.1.2, @codingame/monaco-vscode-layout-service-override@25.1.2, @codingame/monaco-vscode-localization-service-override@25.1.2, @codingame/monaco-vscode-log-service-override@25.1.2, @codingame/monaco-vscode-model-service-override@25.1.2, @codingame/monaco-vscode-monarch-service-override@25.1.2, @codingame/monaco-vscode-quickaccess-service-override@25.1.2, @codingame/monaco-vscode-standalone-languages@25.1.2, @codingame/monaco-vscode-textmate-service-override@25.1.2, @codingame/monaco-vscode-theme-defaults-default-extension@25.1.2, @codingame/monaco-vscode-theme-service-override@25.1.2, @codingame/monaco-vscode-view-banner-service-override@25.1.2, @codingame/monaco-vscode-view-common-service-override@25.1.2, @codingame/monaco-vscode-view-status-bar-service-override@25.1.2, @codingame/monaco-vscode-view-title-bar-service-override@25.1.2, @codingame/monaco-vscode-views-service-override@25.1.2, @codingame/monaco-vscode-workbench-service-override@25.1.2, @git-diff-view/core@0.1.7, @git-diff-view/lowlight@0.1.7, @git-diff-view/react@0.1.7, @iconify/types@2.0.0, @iconify/utils@3.1.4, @mermaid-js/parser@1.2.0, @oxc-project/types@0.139.0, @oxlint/binding-darwin-arm64@1.74.0, @rolldown/binding-darwin-arm64@1.1.5, @rolldown/pluginutils@1.0.1, @types/d3-array@3.2.2, @types/d3-axis@3.0.6, @types/d3-brush@3.0.6, @types/d3-chord@3.0.6, @types/d3-color@3.1.3, @types/d3-contour@3.0.6, @types/d3-delaunay@6.0.4, @types/d3-dispatch@3.0.7, @types/d3-drag@3.0.7, @types/d3-dsv@3.0.7, @types/d3-ease@3.0.2, @types/d3-fetch@3.0.7, @types/d3-force@3.0.10, @types/d3-format@3.0.4, @types/d3-geo@3.1.0, @types/d3-hierarchy@3.1.7, @types/d3-interpolate@3.0.4, @types/d3-path@3.1.1, @types/d3-polygon@3.0.2, @types/d3-quadtree@3.0.6, @types/d3-random@3.0.4, @types/d3-scale-chromatic@3.1.0, @types/d3-scale@4.0.9, @types/d3-selection@3.0.11, @types/d3-shape@3.1.8, @types/d3-time-format@4.0.3, @types/d3-time@3.0.4, @types/d3-timer@3.0.2, @types/d3-transition@3.0.9, @types/d3-zoom@3.0.8, @types/d3@7.4.3, @types/geojson@7946.0.16, @types/hast@3.0.5, @types/node@24.13.3, @types/react-dom@19.2.3, @types/react@19.2.17, @types/trusted-types@2.0.7, @types/unist@3.0.3, @upsetjs/venn.js@2.0.0, @vitejs/plugin-react@6.0.3, @vscode/iconv-lite-umd@0.7.1, @vue/reactivity@3.5.40, @vue/shared@3.5.40, @xmldom/xmldom@0.8.13, @xterm/addon-fit@0.11.0, @xterm/addon-serialize@0.14.0, @xterm/addon-unicode11@0.9.0, @xterm/addon-web-links@0.12.0, @xterm/addon-webgl@0.19.0, @xterm/xterm@6.0.0, argparse@1.0.10, balanced-match@1.0.2, base64-js@1.5.1, bluebird@3.4.7, brace-expansion@2.1.2, commander@7.2.0, core-util-is@1.0.3, cose-base@1.0.3, csstype@3.2.3, cytoscape-cose-bilkent@4.1.0, cytoscape-fcose@2.2.0, cytoscape@3.34.0, dagre-d3-es@7.0.14, dayjs@1.11.21, dequal@2.0.3, devlop@1.1.0, es-toolkit@1.49.0, fast-deep-equal@3.1.3, fdir@6.5.0, fsevents@2.3.3, hachure-fill@0.5.2, iconv-lite@0.6.3, immediate@3.0.6, import-meta-resolve@4.2.0, isarray@1.0.0, katex@0.16.47, layout-base@1.0.2, lie@3.3.0, lodash-es@4.18.1, lowlight@3.3.0, marked@18.0.6, material-icon-theme@5.36.1, mermaid@11.16.0, monaco-languageclient@10.7.0, nanoid@3.3.16, oxlint@1.74.0, package-manager-detector@1.7.0, path-data-parser@0.1.0, path-is-absolute@1.0.1, picomatch@4.0.5, points-on-curve@0.2.0, points-on-path@0.2.1, postcss@8.5.19, process-nextick-args@2.0.1, react-dom@19.2.7, react-resizable-panels@2.1.9, react@19.2.7, reactivity-store@0.4.0, readable-stream@2.3.8, rolldown@1.1.5, roughjs@4.6.6, safe-buffer@5.1.2, safer-buffer@2.1.2, scheduler@0.27.0, setimmediate@1.0.5, string_decoder@1.1.1, stylis@4.4.0, tinyexec@1.2.4, tinyglobby@0.2.17, ts-dedent@2.3.0, underscore@1.13.8, undici-types@7.18.2, use-sync-external-store@1.6.0, util-deprecate@1.0.2, uuid@14.0.1, vite@8.1.5, vscode-jsonrpc@8.2.0, vscode-languageclient@9.0.1, vscode-languageserver-protocol@3.17.5, vscode-languageserver-types@3.17.5, vscode-ws-jsonrpc@3.5.0, xmlbuilder@10.1.1

### ISC (36)

d3-array@3.2.4, d3-axis@3.0.0, d3-brush@3.0.0, d3-chord@3.0.1, d3-color@3.1.0, d3-contour@4.0.2, d3-delaunay@6.0.4, d3-dispatch@3.0.1, d3-drag@3.0.0, d3-dsv@3.0.1, d3-fetch@3.0.1, d3-force@3.0.0, d3-format@3.1.2, d3-geo@3.1.1, d3-hierarchy@3.1.2, d3-interpolate@3.0.1, d3-path@3.1.0, d3-polygon@3.0.1, d3-quadtree@3.0.1, d3-random@3.0.1, d3-scale-chromatic@3.1.0, d3-scale@4.0.2, d3-selection@3.0.0, d3-shape@3.2.0, d3-time-format@4.1.0, d3-time@3.1.0, d3-timer@3.0.1, d3-transition@3.0.1, d3-zoom@3.0.0, d3@7.9.0, delaunator@5.1.0, inherits@2.0.4, internmap@2.0.3, minimatch@5.1.9, picocolors@1.1.1, semver@7.8.5

### BSD-3-Clause (7)

d3-ease@3.0.1, d3-sankey@0.12.3, diff@8.0.4, highlight.js@11.11.1, rw@1.3.3, source-map-js@1.2.1, sprintf-js@1.0.3

### Apache-2.0 (6)

@chevrotain/types@11.1.2, detect-libc@2.1.2, fast-diff@1.3.0, typescript-language-server@5.3.0, typescript@6.0.3, xlsx@0.20.3

### BSD-2-Clause (4)

dingbat-to-unicode@1.0.1, lop@0.4.2, mammoth@1.12.0, option@0.2.4

### Apache-2.0 OR MIT (3)

@tauri-apps/api@2.11.1, @tauri-apps/cli-darwin-arm64@2.11.4, @tauri-apps/cli@2.11.4

### MPL-2.0 (2)

lightningcss-darwin-arm64@1.32.0, lightningcss@1.32.0

### (BSD-3-Clause AND Apache-2.0) (1)

chroma-js@3.2.0

### (MIT AND Zlib) (1)

pako@1.0.11

### (MIT OR GPL-3.0-or-later) (1)

jszip@3.10.1

### (MPL-2.0 OR Apache-2.0) (1)

dompurify@3.3.1

### BSD (1)

duck@0.1.12

### LGPL-2.1+ (1)

jschardet@3.1.4

### MIT OR Apache-2.0 (1)

@tauri-apps/plugin-dialog@2.7.1

### Unlicense (1)

robust-predicates@3.0.3

