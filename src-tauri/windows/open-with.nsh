; Lists Canopy under Explorer's "Open with" for text and source files without
; ever taking over a default. Tauri's `bundle.fileAssociations` is not used on
; Windows because its APP_ASSOCIATE macro rewrites `Software\Classes\.<ext>`'s
; default value, which makes Canopy the handler for every listed extension.
;
; Written here, under SHELL_CONTEXT (HKCU for a per-user install, HKLM for a
; per-machine one; Tauri's SetContext picks it in .onInit / un.onInit):
;   Software\Classes\Canopy.SourceFile                      ProgID
;   Software\Classes\Applications\<exe>                     app registration
;   Software\Classes\.<ext>\OpenWithProgids  Canopy.SourceFile = ""
; The `.<ext>` default value is never read or written.
;
; Tauri !includes this file near the top of installer.nsi, before
; MAINBINARYNAME is defined, so nothing at file level may use it. Macro bodies
; expand where the hooks are inserted, by which point it is defined.

!define CANOPY_PROGID "Canopy.SourceFile"

; The one list of extensions. Install and uninstall both walk it, so they
; cannot drift apart. Keep it in step with open-with.wxs.
!macro CANOPY_FOR_EACH_EXT _MACRO
  !insertmacro ${_MACRO} "txt"
  !insertmacro ${_MACRO} "log"
  !insertmacro ${_MACRO} "md"
  !insertmacro ${_MACRO} "markdown"
  !insertmacro ${_MACRO} "json"
  !insertmacro ${_MACRO} "xml"
  !insertmacro ${_MACRO} "yml"
  !insertmacro ${_MACRO} "yaml"
  !insertmacro ${_MACRO} "toml"
  !insertmacro ${_MACRO} "csv"
  !insertmacro ${_MACRO} "css"
  !insertmacro ${_MACRO} "js"
  !insertmacro ${_MACRO} "mjs"
  !insertmacro ${_MACRO} "cjs"
  !insertmacro ${_MACRO} "ts"
  !insertmacro ${_MACRO} "tsx"
  !insertmacro ${_MACRO} "mts"
  !insertmacro ${_MACRO} "cts"
  !insertmacro ${_MACRO} "jsx"
  !insertmacro ${_MACRO} "py"
  !insertmacro ${_MACRO} "rs"
  !insertmacro ${_MACRO} "go"
  !insertmacro ${_MACRO} "c"
  !insertmacro ${_MACRO} "h"
  !insertmacro ${_MACRO} "cc"
  !insertmacro ${_MACRO} "cpp"
  !insertmacro ${_MACRO} "cxx"
  !insertmacro ${_MACRO} "hh"
  !insertmacro ${_MACRO} "hpp"
  !insertmacro ${_MACRO} "hxx"
  !insertmacro ${_MACRO} "java"
  !insertmacro ${_MACRO} "kt"
  !insertmacro ${_MACRO} "kts"
  !insertmacro ${_MACRO} "cs"
  !insertmacro ${_MACRO} "rb"
  !insertmacro ${_MACRO} "php"
  !insertmacro ${_MACRO} "sh"
  !insertmacro ${_MACRO} "bash"
  !insertmacro ${_MACRO} "zsh"
  !insertmacro ${_MACRO} "sql"
  !insertmacro ${_MACRO} "mk"
  !insertmacro ${_MACRO} "scala"
  !insertmacro ${_MACRO} "dart"
  !insertmacro ${_MACRO} "zig"
  !insertmacro ${_MACRO} "lua"
  !insertmacro ${_MACRO} "ex"
  !insertmacro ${_MACRO} "exs"
  !insertmacro ${_MACRO} "erl"
  !insertmacro ${_MACRO} "hs"
  !insertmacro ${_MACRO} "ml"
  !insertmacro ${_MACRO} "clj"
  !insertmacro ${_MACRO} "nim"
  !insertmacro ${_MACRO} "jl"
  !insertmacro ${_MACRO} "r"
  !insertmacro ${_MACRO} "vue"
  !insertmacro ${_MACRO} "svelte"
  !insertmacro ${_MACRO} "astro"
  !insertmacro ${_MACRO} "ini"
  !insertmacro ${_MACRO} "cfg"
  !insertmacro ${_MACRO} "conf"
  !insertmacro ${_MACRO} "env"
  !insertmacro ${_MACRO} "properties"
  !insertmacro ${_MACRO} "lock"
  !insertmacro ${_MACRO} "jsonc"
  !insertmacro ${_MACRO} "json5"
  !insertmacro ${_MACRO} "mdx"
  !insertmacro ${_MACRO} "graphql"
  !insertmacro ${_MACRO} "gql"
  !insertmacro ${_MACRO} "proto"
  !insertmacro ${_MACRO} "tf"
  !insertmacro ${_MACRO} "tfvars"
  !insertmacro ${_MACRO} "hcl"
  !insertmacro ${_MACRO} "gradle"
  !insertmacro ${_MACRO} "cmake"
  !insertmacro ${_MACRO} "nix"
  !insertmacro ${_MACRO} "dockerfile"
  !insertmacro ${_MACRO} "gitignore"
  !insertmacro ${_MACRO} "editorconfig"
  !insertmacro ${_MACRO} "ps1"
  !insertmacro ${_MACRO} "bat"
  !insertmacro ${_MACRO} "cmd"
!macroend

!macro CANOPY_OPEN_WITH_ADD EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${CANOPY_PROGID}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

; Only our value goes: other apps' OpenWithProgids entries share the key.
; SupportedTypes goes with the Applications key below.
!macro CANOPY_OPEN_WITH_REMOVE EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${CANOPY_PROGID}"
!macroend

; Runs after files, shortcuts and Tauri's own registry keys are in place.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHELL_CONTEXT "Software\Classes\${CANOPY_PROGID}" "" "Source file"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${CANOPY_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${CANOPY_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Canopy"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  !insertmacro CANOPY_FOR_EACH_EXT CANOPY_OPEN_WITH_ADD

  ; SHCNE_ASSOCCHANGED, so Explorer picks the entries up without a restart.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CANOPY_FOR_EACH_EXT CANOPY_OPEN_WITH_REMOVE
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${CANOPY_PROGID}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
