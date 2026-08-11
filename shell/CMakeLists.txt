# Riffsheet - bass/guitar riff -> sheet music + tab. VST3 / AU / Standalone.
# The native shell: a JUCE plugin whose entire editor is a WebView hosting the
# webcore web app. Several build patterns here are inherited from BASAMAK, an
# earlier JUCE project by the same author on the same toolchain; where that
# matters, the comment below says so.
cmake_minimum_required(VERSION 3.22)
project(Riffsheet VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Windows: statically link the MSVC runtime so users don't need the VC++
# Redistributable. (Inherited from BASAMAK - the user tests on a Windows PC.)
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# /utf-8 FOR OUR OWN TARGETS, AND IT IS NOT COSMETIC. Every source file here is
# UTF-8, and the engine manifest holds user-visible prose in it. Without this
# flag MSVC reads the source in the machine's ANSI code page and re-encodes
# narrow literals into the execution code page, so an em dash in the MuScriptor
# install guide would reach the binary as something else entirely - the same
# class of bug EngineManifest.h's manifestText() fixes on the JUCE side,
# arriving one layer earlier and on one platform only. Both halves are needed:
# this makes the bytes in the binary UTF-8, manifestText() makes juce::String
# read them as UTF-8.
#
# Applied per target rather than with add_compile_options(), which would also
# reach JUCE - added as a subdirectory below - and changing how a third-party
# library compiles is not this fix's business.
function(riffsheet_use_utf8_source target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /utf-8)
    endif()
endfunction()

# ---- Locate JUCE. Same resolution order BASAMAK uses: -DJUCE_DIR, env JUCE_DIR,
# ~/JUCE, %USERPROFILE%\JUCE. On this Mac ~/JUCE is 8.0.13 (has the WebView
# native-integration API this project is built on - JUCE >= 8.0.1 required).
if(NOT DEFINED JUCE_DIR)
    if(DEFINED ENV{JUCE_DIR})
        set(JUCE_DIR "$ENV{JUCE_DIR}")
    elseif(EXISTS "$ENV{HOME}/JUCE/CMakeLists.txt")
        set(JUCE_DIR "$ENV{HOME}/JUCE")
    elseif(EXISTS "$ENV{USERPROFILE}/JUCE/CMakeLists.txt")
        set(JUCE_DIR "$ENV{USERPROFILE}/JUCE")
    endif()
endif()
if(NOT JUCE_DIR OR NOT EXISTS "${JUCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "JUCE not found. Pass -DJUCE_DIR=path/to/JUCE "
                        "(git clone https://github.com/juce-framework/JUCE - needs 8.x)")
endif()
add_subdirectory(${JUCE_DIR} JUCE)

set(RIFFSHEET_JUCE_JS "${JUCE_DIR}/modules/juce_gui_extra/native/javascript/index.js")
if(NOT EXISTS "${RIFFSHEET_JUCE_JS}")
    message(FATAL_ERROR "This JUCE has no WebView frontend library "
                        "(${RIFFSHEET_JUCE_JS}). Riffsheet needs JUCE 8.0.1+.")
endif()

# ---- Code signing -----------------------------------------------------------
# This repo lives under ~/Desktop, which is iCloud-synced on this Mac, and the
# file provider stamps com.apple.FinderInfo onto built bundles. Xcode's own
# CodeSign phase then dies with "resource fork, Finder information, or similar
# detritus not allowed". So Xcode does not sign; scripts/build.sh strips the
# xattrs and ad-hoc signs afterwards, which is all a local plugin needs.
# (A checkout that lives outside an iCloud-synced folder never hits this.)
if(APPLE)
    set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED "NO")
    set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED "NO")
    set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "")
endif()

string(TIMESTAMP BUILD_TS "%Y%m%d-%H%M")

# Dev builds embed a timestamp in the product name so iterative rebuilds never
# leave two installed copies sharing one plugin UID - that combination hangs
# REAPER's scanner. -DRIFFSHEET_RELEASE=ON gives the clean distributable name.
# (Straight out of BASAMAK; the user hit this exact REAPER bug there.)
option(RIFFSHEET_RELEASE "Clean product name for distribution, no auto-install" OFF)
if(RIFFSHEET_RELEASE)
    set(RIFFSHEET_PRODUCT_NAME "Riffsheet")
    set(RIFFSHEET_COPY_AFTER_BUILD FALSE)
else()
    set(RIFFSHEET_PRODUCT_NAME "Riffsheet ${BUILD_TS}")
    set(RIFFSHEET_COPY_AFTER_BUILD TRUE)
endif()

# ---------------------------------------------------------------------------
# webcore bundle  (Team B's territory: ../webcore)
# ---------------------------------------------------------------------------
# The web app is packed into ONE zip that is embedded in the binary as
# BinaryData. Embedding (rather than dropping files in the bundle's Resources/)
# is what keeps the Windows standalone working - a bare .exe has no Resources
# folder. The resource provider unzips on demand at runtime.
#
# Search order for the source directory:
#   -DRIFFSHEET_WEBCORE_DIR=...   explicit
#   ../webcore/dist               Team B's build output
#   Resources/webcore             the placeholder shipped with this repo
#
# For live iteration Team B does NOT need to rebuild the plugin: set the env var
# RIFFSHEET_WEBCORE_DIR at runtime and the resource provider serves from disk.
#
# Team B's drop-in contract: as soon as ../webcore/dist/index.html loads its code
# with CLASSIC <script src> tags, the next build embeds it automatically and the
# placeholder disappears. Nothing else to coordinate.
#
# Until then we refuse it on purpose. WKWebView will not load ES modules over the
# juce:// scheme (see BRIDGE.md §0), so a module-based bundle renders a blank
# window - far worse than an honest placeholder.
#
# The refusal applies on every platform, not just macOS. The measurement behind
# it (design notes §4.2) was taken on macOS WKWebView; nobody has re-measured it on
# Windows WebView2, where JUCE serves from https://juce.backend/, or Linux
# WebKitGTK, where JUCE uses the same juce://juce.backend/ custom scheme as
# macOS. Until somebody does, all three platforms get the same classic-script
# bundle - one unknown is better than three.
#
# The quiet fallback to the placeholder is right for a human at a terminal, who
# reads the warning. It is wrong for CI, where a webcore build that failed
# earlier in the job would produce a green run and a plugin containing the
# shell's own test panel. -DRIFFSHEET_REQUIRE_WEBCORE=ON turns that fallback into
# a hard error, and the CI workflow always passes it.
option(RIFFSHEET_REQUIRE_WEBCORE
       "Fail the configure rather than silently falling back to the placeholder web UI" OFF)

if(NOT DEFINED RIFFSHEET_WEBCORE_DIR)
    set(_rs_dist "${CMAKE_CURRENT_SOURCE_DIR}/../webcore/dist")

    if(EXISTS "${_rs_dist}/index.html")
        file(READ "${_rs_dist}/index.html" _rs_index)

        if(_rs_index MATCHES "<script[^>]*type=[\"']module[\"']")
            if(RIFFSHEET_REQUIRE_WEBCORE)
                message(FATAL_ERROR
                    "Riffsheet: ../webcore/dist/index.html loads ES modules "
                    "(<script type=\"module\">), which the plugin's WebView will not "
                    "run. Refusing to build, because -DRIFFSHEET_REQUIRE_WEBCORE=ON "
                    "was passed. See shell/BRIDGE.md section 0.")
            endif()

            message(WARNING
                "Riffsheet: ../webcore/dist/index.html loads ES modules "
                "(<script type=\"module\">). WKWebView cannot load those over the "
                "juce:// scheme, so it would render a blank window. Embedding the "
                "placeholder instead. Team B: build a classic/IIFE bundle - see "
                "shell/BRIDGE.md section 0. Override with -DRIFFSHEET_WEBCORE_DIR.")
            set(RIFFSHEET_WEBCORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/Resources/webcore")
        else()
            set(RIFFSHEET_WEBCORE_DIR "${_rs_dist}")
        endif()
    else()
        if(RIFFSHEET_REQUIRE_WEBCORE)
            message(FATAL_ERROR
                "Riffsheet: there is no ../webcore/dist/index.html, so this build "
                "would embed the shell's placeholder panel instead of the real web "
                "app. Refusing, because -DRIFFSHEET_REQUIRE_WEBCORE=ON was passed. "
                "Build the web app first: 'npm ci && npm run build' in webcore/.")
        endif()

        set(RIFFSHEET_WEBCORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/Resources/webcore")
    endif()
endif()
message(STATUS "Riffsheet: webcore source = ${RIFFSHEET_WEBCORE_DIR}")

set(RIFFSHEET_WEBCORE_ZIP "${CMAKE_CURRENT_BINARY_DIR}/webcore.zip")
set(RIFFSHEET_WEBCORE_STAGE "${CMAKE_CURRENT_BINARY_DIR}/webcore-stage")

# Pack once at configure time so the file exists for juce_add_binary_data...
execute_process(COMMAND ${CMAKE_COMMAND}
    -DSRC=${RIFFSHEET_WEBCORE_DIR} -DJUCEJS=${RIFFSHEET_JUCE_JS}
    -DSTAGE=${RIFFSHEET_WEBCORE_STAGE} -DOUT=${RIFFSHEET_WEBCORE_ZIP}
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/PackWebcore.cmake"
    RESULT_VARIABLE pack_result)
if(NOT pack_result EQUAL 0)
    message(FATAL_ERROR "Riffsheet: failed to pack webcore from ${RIFFSHEET_WEBCORE_DIR}")
endif()

# Give Ninja/Xcode a real file dependency rather than an always-run phony
# target. With only add_dependencies(), Ninja decided whether BinaryData.cpp
# was stale BEFORE the phony pack target rewrote webcore.zip, so the first
# rebuild after a web edit silently embedded the previous bundle. CONFIGURE_DEPENDS
# also makes adding/removing a dist asset refresh this input list.
file(GLOB_RECURSE RIFFSHEET_WEBCORE_INPUTS CONFIGURE_DEPENDS
    LIST_DIRECTORIES false "${RIFFSHEET_WEBCORE_DIR}/*")
get_filename_component(RIFFSHEET_JUCE_JS_DIR "${RIFFSHEET_JUCE_JS}" DIRECTORY)

add_custom_command(OUTPUT "${RIFFSHEET_WEBCORE_ZIP}"
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${RIFFSHEET_WEBCORE_DIR} -DJUCEJS=${RIFFSHEET_JUCE_JS}
        -DSTAGE=${RIFFSHEET_WEBCORE_STAGE} -DOUT=${RIFFSHEET_WEBCORE_ZIP}
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/PackWebcore.cmake"
    DEPENDS
        ${RIFFSHEET_WEBCORE_INPUTS}
        "${RIFFSHEET_JUCE_JS}"
        "${RIFFSHEET_JUCE_JS_DIR}/check_native_interop.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/cmake/PackWebcore.cmake"
    COMMENT "Packing webcore bundle -> webcore.zip"
    VERBATIM)
add_custom_target(riffsheet_pack_webcore DEPENDS "${RIFFSHEET_WEBCORE_ZIP}")

# ---------------------------------------------------------------------------
# ONNX Runtime + the release audit
# ---------------------------------------------------------------------------
# ORT is the one native dependency this project has beyond JUCE, and it is
# statically linked: see cmake/OnnxRuntime.cmake for why nothing prebuilt is
# usable and BUILDING.md section 5 for the build invocation per platform.
include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/OnnxRuntime.cmake)
include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ReleaseAudit.cmake)

# The models that go INTO the binary. The rule (engine-architecture.md 6.6):
# 1 MB or less is embedded, anything larger ships as a bundle resource, because
# juce_add_plugin links three products on macOS and an embedded byte is paid
# three times. nmp.onnx is 225 KiB, so it is embedded and BinaryData gains
# nmp_onnx / nmp_onnxSize beside webcore_zip.
#
# NOTE for whoever adds the SECOND binary-data target: this one has no
# HEADER_NAME, so a second one would put a second BinaryData.h on the include
# path and the failure is confusing. Give both a HEADER_NAME at that point.
#
# WAVE 4, AND WHY beat-this/small0.onnx IS EMBEDDED DESPITE BEING 10.1 MiB. The
# rule's stated reason for the 1 MB cutoff is "an embedded byte is paid three
# times". A bundle resource is paid three times too - each of the three products
# gets its own Contents/Resources - so the rule's premise does not separate the
# two options here; what separates them is that the resource route needs staging,
# code-signing and workflow changes in files wave 4 does not own, and has no
# bundle at all to live in on Windows or Linux. Measured: +7.7 MB per product zip
# (20.3 -> 27.7 MB against a 35 MB budget) and +22.9 MB on the bundle (60.4 ->
# 83.3 against 100). Both fit; the table is in BUILDING.md section 5.
set(RIFFSHEET_BINARY_MODELS "")
if(NOT RIFFSHEET_WITHOUT_BASIC_PITCH)
    list(APPEND RIFFSHEET_BINARY_MODELS
         "${CMAKE_CURRENT_SOURCE_DIR}/Resources/models/basic-pitch/nmp.onnx")
    list(APPEND RIFFSHEET_BINARY_MODELS
         "${CMAKE_CURRENT_SOURCE_DIR}/Resources/models/beat-this/small0.onnx")
endif()

# WAVE 5. The one-click installer's own resources: the sidecar script it writes
# into an installed engine's folder, and the hash-pinned pip lock files it runs
# pip against. These are text, they total about 20 KB, and they are the ONLY
# bytes any downloadable engine contributes to the binary - the engines
# themselves (a gigabyte of torch, 113 MB of checkpoints) are fetched at install
# time into <appSupport>/engines and are never in a release. A lock file is per
# platform because a wheel hash is per platform; a platform with none cannot
# one-click install and says so instead of guessing.
file(GLOB RIFFSHEET_ENGINE_RESOURCES CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/Resources/engines/*.py"
     "${CMAKE_CURRENT_SOURCE_DIR}/Resources/engines/*.txt")

juce_add_binary_data(RiffsheetData SOURCES "${RIFFSHEET_WEBCORE_ZIP}" ${RIFFSHEET_BINARY_MODELS}
                                           ${RIFFSHEET_ENGINE_RESOURCES})
add_dependencies(RiffsheetData riffsheet_pack_webcore)
set_target_properties(RiffsheetData PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ---------------------------------------------------------------------------
# The plugin
# ---------------------------------------------------------------------------
# Codes follow BASAMAK's convention: COMPANY_NAME "OZ", manufacturer code OZ95,
# bundle id com.OZ.<Product>. Riffsheet is an audio EFFECT (not a synth) so it
# can sit on the bass track and hear it; it emits the transcription as MIDI out.

# AU is a macOS format and nothing else: its wrapper is Objective-C++ and its
# artefact is a .component bundle. JUCE's own CMake already drops AU from the
# format list off Darwin (_juce_get_platform_plugin_kinds in
# JUCEModuleSupport.cmake), so leaving it in would still configure - but then
# nothing here would explain why the Windows zip has no AU in it, and the next
# person would have to go and read JUCE's internals to find out. Saying it out
# loud costs nothing. The macOS list is exactly what it has always been.
if(APPLE)
    set(RIFFSHEET_FORMATS VST3 AU Standalone)
else()
    set(RIFFSHEET_FORMATS VST3 Standalone)
endif()

# NEEDS_WEBVIEW2 below makes JUCE run find_package(WebView2 REQUIRED), and that
# find script only looks inside a local NuGet package folder - there is no
# system-wide WebView2 SDK to fall back on. Without it the configure dies in
# JUCE's code with "Could NOT find WebView2 (missing: WebView2_include_dir
# WebView2_library)", which says nothing about what to do. Say it here instead,
# where the answer fits in the message. UNTESTED on a real Windows machine: this
# check was written from JUCE's FindWebView2.cmake, not from a failed build.
if(WIN32 AND NOT JUCE_WEBVIEW2_PACKAGE_LOCATION)
    file(GLOB _rs_wv2
         "$ENV{USERPROFILE}/AppData/Local/PackageManagement/NuGet/Packages/*Microsoft.Web.WebView2*")

    if(NOT _rs_wv2)
        message(FATAL_ERROR
            "Riffsheet: the Microsoft.Web.WebView2 NuGet package is not installed, "
            "and the whole UI is a WebView so the Windows build cannot do without "
            "it. Either install it:\n"
            "    nuget install Microsoft.Web.WebView2 -Version 1.0.3485.44 -OutputDirectory C:\\wv2\n"
            "and configure with -DJUCE_WEBVIEW2_PACKAGE_LOCATION=C:\\wv2, or follow "
            "the PowerShell route in BUILDING.md. This is what .github/workflows/"
            "build.yml does on the Windows runner.")
    endif()
endif()

juce_add_plugin(Riffsheet
    # The app icon: an "R" cut on BASAMAK's icon grid (see Resources/Icon/
    # riffsheet-icon.svg for the shared metrics), in Riffsheet's accent on its
    # own canvas. JUCE turns these two PNGs into the macOS .icns inside every
    # bundle's Contents/Resources and stamps CFBundleIconFile in the generated
    # Info.plist, into the Windows .exe, and into the Linux window icon - which
    # is why they are PNGs here rather than the Riffsheet.icns sitting beside
    # them. That .icns is the hand-built, full 16-1024 iconset, kept for
    # anything outside this target (installers, the website, Finder previews).
    ICON_BIG   "Resources/Icon/riffsheet-icon-512.png"
    ICON_SMALL "Resources/Icon/riffsheet-icon-128.png"
    COMPANY_NAME "OZ"
    VERSION ${PROJECT_VERSION}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE      # the WebView needs key events (text entry in the score UI)
    NEEDS_WEB_BROWSER TRUE                # links webkit on Linux
    NEEDS_WEBVIEW2 TRUE                   # static WebView2 on Windows
    COPY_PLUGIN_AFTER_BUILD ${RIFFSHEET_COPY_AFTER_BUILD}
    PLUGIN_MANUFACTURER_CODE OZ95
    PLUGIN_CODE Rfsh
    BUNDLE_ID com.OZ.Riffsheet
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Riffsheet listens to your instrument to write it out as notation."
    FORMATS ${RIFFSHEET_FORMATS}
    PRODUCT_NAME "${RIFFSHEET_PRODUCT_NAME}"
)

juce_generate_juce_header(Riffsheet)

target_sources(Riffsheet PRIVATE
    Source/plugin/PluginProcessor.cpp
    Source/plugin/TrackCapture.cpp
    Source/ui/PluginEditor.cpp
    Source/bridge/WebResources.cpp
    Source/bridge/PcmStore.cpp
    Source/bridge/SystemProbe.cpp       # RAM, pids, the Application Support folder
    Source/bridge/ScoreImageImporter.cpp # printed score/PDF -> MusicXML through Audiveris
    Source/bridge/EngineLock.cpp        # one transcription at a time, machine-wide
    Source/bridge/ServerRegistry.cpp    # servers we started, so a force-quit leaves nothing behind
    Source/bridge/ModelCatalog.cpp      # which weights are on disk, and which one 'auto' means
    Source/bridge/MuScriptorProbe.cpp    # "is a MuScriptor answering on this port?", asked over HTTP
    Source/bridge/MuScriptorServer.cpp
    Source/bridge/NativeBridge.cpp
    Source/engines/EngineCatalog.cpp    # the compiled-in engine table + its licensing invariants
    Source/engines/EngineSettings.cpp   # which engine the user chose, in <appSupport>/engine.json
    Source/engines/EngineRegistry.cpp   # owns the adapters and decides what 'auto' means
    Source/engines/MuScriptorAdapter.cpp # engine #1: the existing server, behind the common door
    Source/engines/EnginePreprocess.cpp  # A440 + -12 dBFS before the engines whose manifest asks
    Source/engines/EngineInstaller.cpp   # verified downloads, venvs, and nothing trusted on faith
    Source/engines/sidecar/SidecarAdapter.cpp # engines #3 and #4: one class, two manifest rows
    Source/engines/sidecar/SidecarMidi.cpp    # notes back out of a Standard MIDI File
)

# Everything that needs ONNX Runtime, in one block: the flag means "no inference
# runtime at all", which since wave 4 takes beat tracking with it.
if(NOT RIFFSHEET_WITHOUT_BASIC_PITCH)
    target_sources(Riffsheet PRIVATE
        Source/engines/onnx/OrtSession.cpp        # the whole inference surface, shared by both
        Source/engines/onnx/ModelLocator.cpp      # BinaryData -> bundle Resources -> appSupport
        Source/engines/basicpitch/BasicPitchFrontend.cpp
        Source/engines/basicpitch/BasicPitchNotes.cpp   # the Apache-2.0 port; see NOTICE.md
        Source/engines/basicpitch/BasicPitchAdapter.cpp # engine #2: built in, no setup at all
        Source/engines/beats/BeatThisFrontend.cpp  # log-mel front end; the numbers are upstream's
        Source/engines/beats/BeatDbn.cpp           # the bar-pointer DBN, DBN on at min_bpm 30
        Source/engines/beats/BeatTracker.cpp       # preciseBeats for every engine, no venv
    )
endif()

target_include_directories(Riffsheet PRIVATE
    Source
    Source/plugin
    Source/ui
    Source/bridge
    Source/engines
)

# WAVE 5, AND IT IS NOT A PREFERENCE. JUCE's Linux WebInputStream without curl is
# a raw POSIX socket with no TLS whatsoever, so an https:// download there does
# not fail loudly - it fails obscurely, and the one-click installer is entirely
# https downloads. macOS uses NSURLSession and Windows uses WinHTTP, both fine,
# so they keep JUCE_USE_CURL=0 and nothing about the existing localhost HTTP
# client changes on the platforms that were working. The Linux CI leg installs
# libcurl4-openssl-dev for exactly this.
#
# AND TURNING THE DEFINE ON IS ONLY HALF OF IT. JUCE_USE_CURL=1 makes juce_core
# CALL curl_easy_init(); it does not make anything LINK libcurl. JUCE links it
# itself only for targets built through its own module system with the flag
# already set, which the plugin's shared-code target is not - so the Linux CI
# leg compiled cleanly and then died at the Standalone and VST3 link steps with
# undefined references to curl_easy_init/curl_easy_setopt/curl_easy_perform.
# find_package + the link below is the missing half. REQUIRED on purpose: a
# Linux build that quietly falls back to the TLS-less socket is exactly what
# this block exists to prevent, so a missing libcurl-dev must stop the configure
# and say so, not produce a plugin whose https installer fails obscurely at
# runtime. (The CI Linux leg already apt-installs libcurl4-openssl-dev.)
#
# The TEST binary is deliberately not part of this - it sets JUCE_USE_CURL=0 for
# itself and never fetches over TLS; see the block at the bottom of this file.
if(UNIX AND NOT APPLE)
    set(RIFFSHEET_USE_CURL 1)
    find_package(CURL REQUIRED)
else()
    set(RIFFSHEET_USE_CURL 0)
endif()

riffsheet_use_utf8_source(Riffsheet)

target_compile_definitions(Riffsheet PUBLIC
    JUCE_WEB_BROWSER=1                    # <- the whole point; BASAMAK had this at 0
    JUCE_USE_CURL=${RIFFSHEET_USE_CURL}
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_MODAL_LOOPS_PERMITTED=0
    RIFFSHEET_VERSION="${PROJECT_VERSION}"
)

# NEEDS_WEBVIEW2 above finds and links WebView2LoaderStatic.lib, but JUCE keeps
# the WebView2 implementation behind a separate module flag. Without this flag
# JUCE_WINDOWS is true while JUCE_USE_WIN_WEBVIEW2 is false, so the public
# Options::withResourceProvider API is compiled out of the header and the real
# embedded UI cannot be served. The static-linking flag also enables
# JUCE_USE_WIN_WEBVIEW2 internally; keep it Windows-only so the other platform
# backends retain their normal configuration.
if(WIN32)
    target_compile_definitions(Riffsheet PUBLIC
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
endif()

target_link_libraries(Riffsheet PRIVATE
    RiffsheetData
    riffsheet::onnxruntime
    juce::juce_audio_utils
    juce::juce_audio_plugin_client
    juce::juce_cryptography    # juce::SHA256, for the installer's pinned downloads
    juce::juce_dsp
    juce::juce_gui_extra
PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

# The other half of JUCE_USE_CURL=1 above. `Riffsheet` is juce_add_plugin's
# shared-code STATIC library, and CMake records a static library's PRIVATE link
# dependencies as $<LINK_ONLY:...> in its interface - so this reaches the
# Standalone and VST3 link lines, which is where the undefined symbols were.
# Same mechanism riffsheet::onnxruntime already relies on.
if(UNIX AND NOT APPLE)
    target_link_libraries(Riffsheet PRIVATE CURL::libcurl)
endif()

# A release must not be assembled out of undeclared bytes. RIFFSHEET_RELEASE=ON
# is the flag scripts/build.sh --release and every CI leg pass, so this makes the
# audit unskippable exactly where it matters and invisible during dev iteration.
if(RIFFSHEET_RELEASE)
    add_dependencies(Riffsheet riffsheet_release_audit)
endif()

# ---------------------------------------------------------------------------
# The C++ unit tests                                    -DRIFFSHEET_BUILD_TESTS=ON
# ---------------------------------------------------------------------------
# There was no C++ test anywhere in this repo before the multi-engine work, and
# BUILDING.md says out loud that a green CI badge means only "it compiles". The
# engine work adds exactly the kind of code that is silently wrong - a manifest
# with licensing invariants, a settings file two processes share, a resolver
# that picks which engine runs - so it gets a test binary.
#
# juce::UnitTest, not GTest or Catch2: it is in juce_core, which is already
# linked, and a first third-party test dependency would buy nothing.
#
# IT MUST NOT LINK THE `Riffsheet` TARGET. That target exports
# juce_recommended_lto_flags and the plugin client PUBLICly, so linking it would
# drag a plugin wrapper (and minutes of LTO) into a console app. The units under
# test are compiled straight into the test binary instead - which also means a
# unit under test must not depend on the plugin host to be testable, and that is
# a feature, not an inconvenience.
#
# Off by default, so an ordinary build is untouched. Build directory is
# shell/build_tests/, which .gitignore already reserves.
option(RIFFSHEET_BUILD_TESTS "Build the C++ unit tests" OFF)

if(RIFFSHEET_BUILD_TESTS)
    enable_testing()

    juce_add_console_app(RiffsheetTests PRODUCT_NAME "RiffsheetTests")
    juce_generate_juce_header(RiffsheetTests)

    # The encoding test in EngineCatalogTests.cpp is only meaningful if the
    # bytes it reads are the bytes the source file holds.
    riffsheet_use_utf8_source(RiffsheetTests)

    target_sources(RiffsheetTests PRIVATE
        test/TestMain.cpp
        test/EngineCatalogTests.cpp
        test/EngineSettingsTests.cpp
        test/EngineRegistryTests.cpp
        test/PreprocessTests.cpp                 # wave 6, and it generates its own audio
        test/EngineInstallerTests.cpp            # wave 5, and it serves its own HTTP
        test/MuScriptorProbeTests.cpp            # the external-server handshake, over a real socket
        # ...one file per wave, added by that wave.

        # The units under test, compiled in directly. NOT NativeBridge.cpp,
        # which needs a plugin host, and NOT MuScriptorAdapter.cpp, which would
        # pull the whole Python server in behind it. SidecarAdapter.cpp is out
        # for the same reason - it speaks PcmStore through EngineAdapter.h - and
        # the two pieces of it that can be silently wrong, the downloader and the
        # MIDI reader, are separate files precisely so they can be in here.
        Source/engines/EngineCatalog.cpp
        Source/engines/EngineSettings.cpp
        Source/engines/EngineRegistry.cpp
        Source/engines/EnginePreprocess.cpp   # deliberately free of PcmStore, so it tests standalone
        Source/engines/EngineInstaller.cpp
        Source/engines/sidecar/SidecarMidi.cpp
        # SidecarAdapter IS in here, unlike the other two adapters: it touches
        # PcmStore only as a type it carries and never calls, so it links without
        # the plugin - and the live install test drives the real one rather than
        # a copy of it.
        Source/engines/sidecar/SidecarAdapter.cpp
        Source/bridge/SystemProbe.cpp
        # The handshake half of external-server detection. It is in here and
        # MuScriptorServer.cpp is not for the reason the list above gives: this
        # file speaks juce::URL and JSON and nothing else, while the server class
        # drags WebResources - and therefore juce_gui_extra and a WebView - in
        # behind it. Keeping the decision in a unit with no such dependency is
        # what makes it testable at all.
        Source/bridge/MuScriptorProbe.cpp
    )

    # BinaryData, unconditionally: the installer reads the pip lock files and the
    # sidecar script out of it, and a test that proved they exist on disk rather
    # than in the binary would be proving the wrong thing.
    target_link_libraries(RiffsheetTests PRIVATE RiffsheetData)

    if(NOT RIFFSHEET_WITHOUT_BASIC_PITCH)
        # Wave 3. The test binary links RiffsheetData because one of the things
        # under test is precisely that a session builds over the BinaryData blob
        # - proving it against a file on disk would prove the wrong thing.
        # BasicPitchAdapter.cpp is deliberately absent: its glue needs the plugin
        # processor, and the model pass it delegates to (BasicPitchFrontend::analyse)
        # is where the seams that can be wrong actually live.
        target_sources(RiffsheetTests PRIVATE
            test/BasicPitchTests.cpp
            test/BeatTrackerTests.cpp                # wave 4; its fixtures are formulas, not files
            Source/engines/onnx/OrtSession.cpp
            Source/engines/onnx/ModelLocator.cpp
            Source/engines/basicpitch/BasicPitchFrontend.cpp
            Source/engines/basicpitch/BasicPitchNotes.cpp
            Source/engines/beats/BeatThisFrontend.cpp
            Source/engines/beats/BeatDbn.cpp
            Source/engines/beats/BeatTracker.cpp
        )
        target_link_libraries(RiffsheetTests PRIVATE riffsheet::onnxruntime)
    endif()

    # The golden fixtures are read off disk rather than embedded: they are a
    # quarter of a megabyte, they change whenever the model does, and the test
    # binary is not shipped anywhere. Wave 5's MIDI fixture is in there too, so
    # this is not inside the ORT block any more.
    target_compile_definitions(RiffsheetTests PRIVATE
        RIFFSHEET_TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}/test")

    target_include_directories(RiffsheetTests PRIVATE
        Source
        Source/engines
        Source/bridge
    )

    # JUCE_USE_CURL=0 for the TEST binary, on every platform including Linux.
    #
    # The Riffsheet target turns curl ON for Linux because the installer's
    # downloads are https and JUCE's own Linux socket has no TLS. That define is
    # PUBLIC on a target this one deliberately does not link, so juce_core is
    # compiled again here - and on Linux it defaulted to curl, referenced
    # curl_easy_init, and the link failed because nothing here links libcurl.
    #
    # The fix is 0 rather than "link libcurl too": these tests never fetch
    # anything over TLS. The download tests serve their own bytes from a loopback
    # HTTP server precisely so they depend on no network and no certificates, and
    # plain http is exactly what JUCE's built-in socket does handle. Adding a
    # system library to a test binary to support a code path it never takes would
    # be a dependency bought for nothing.
    target_compile_definitions(RiffsheetTests PRIVATE JUCE_USE_CURL=0)

    target_link_libraries(RiffsheetTests PRIVATE
        juce::juce_core
        juce::juce_audio_basics
        juce::juce_audio_formats
        juce::juce_dsp
        juce::juce_cryptography
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

    add_test(NAME riffsheet-unit COMMAND RiffsheetTests)
endif()
