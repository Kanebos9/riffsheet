# ---------------------------------------------------------------------------
# ONNX Runtime, statically linked.                       shell/cmake/OnnxRuntime.cmake
# ---------------------------------------------------------------------------
# Riffsheet's built-in engine (Basic Pitch, wave 3) and its beat tracker
# (beat_this, wave 4) are ONNX graphs, and JUCE has no inference of any kind. So
# there is exactly one new native dependency in this project and this file is the
# whole of it.
#
# STATIC, NOT SHARED, AND THAT IS NOT NEGOTIABLE. A .dylib/.so next to a plugin
# bundle is a loader-path problem in every DAW and a code-signing problem on
# macOS: the standalone, the VST3 and the AU are three separate products with
# three separate bundle layouts, and the host decides the working directory. A
# static archive has none of those failure modes.
#
# WHY THERE IS NO DOWNLOAD HERE. Microsoft publishes prebuilt ONNX Runtime for
# macOS, Windows and Linux, and not one of those builds is usable:
#
#   * macOS   - the published archive is a dynamic library only.
#   * Windows - the published binaries are /MD, and shell/CMakeLists.txt sets
#               CMAKE_MSVC_RUNTIME_LIBRARY to the static CRT so users do not
#               need the VC++ redistributable. /MD objects will not link into a
#               /MT binary.
#   * Linux   - dynamic only, same objection as macOS.
#
# So ORT is built from source, once per platform, and the result is pointed at
# with -DRIFFSHEET_ORT_DIR. BUILDING.md carries the exact invocation for each
# platform and the CI workflow caches the artefact so the cost is paid once.
#
# WHAT THIS FILE EXPECTS TO BE GIVEN. A directory holding:
#
#     <dir>/include/onnxruntime_cxx_api.h      (and the headers beside it)
#     <dir>/lib/*.a                            (or *.lib on Windows)
#
# One merged archive or the whole set of them - both work, because the archives
# are linked as a group. That is deliberate: merging ORT's ~80 static libraries
# into one is a convenience, not a requirement, and a contributor who just copied
# the build tree's archives across should not have to discover that.

set(RIFFSHEET_ORT_VERSION "1.28.0" CACHE STRING
    "The ONNX Runtime version this build expects. Bumping it is a decision, not a default.")

# A build with no engine at all is a legitimate thing to want - somebody
# iterating on the web UI should not have to build ONNX Runtime first. It is not
# a legitimate thing to SHIP, so it has to be typed out loud, and the built-in
# engine then reports itself missing rather than pretending.
option(RIFFSHEET_WITHOUT_BASIC_PITCH
       "Build with no inference runtime at all: no Basic Pitch, no beat tracking. \
Never use this for a release." OFF)

function(_riffsheet_ort_not_found reason)
    message(FATAL_ERROR
        "Riffsheet: ${reason}\n"
        "The built-in transcription engine is ONNX Runtime ${RIFFSHEET_ORT_VERSION}, statically "
        "linked, and it has to be built once for this platform. On this machine:\n"
        "\n"
        "    git clone --depth 1 --branch v${RIFFSHEET_ORT_VERSION} --recurse-submodules \\\n"
        "        https://github.com/microsoft/onnxruntime ~/riffsheet-ort/src\n"
        "    cd ~/riffsheet-ort/src && python3 tools/ci_build/build.py \\\n"
        "        --build_dir ~/riffsheet-ort/build/macos-arm64 --config Release \\\n"
        "        --parallel 6 --skip_tests --cmake_generator Ninja \\\n"
        "        --osx_arch arm64 --apple_deploy_target 11.0 --disable_ml_ops \\\n"
        "        --compile_no_warning_as_error \\\n"
        "        --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF \\\n"
        "                              CMAKE_IGNORE_PREFIX_PATH=/opt/homebrew\n"
        "\n"
        "then stage the headers and archives and configure with\n"
        "-DRIFFSHEET_ORT_DIR=<that folder>. BUILDING.md section 5 has the staging "
        "commands and the Windows and Linux invocations.\n"
        "\n"
        "To build the rest of Riffsheet without any inference at all - no built-in "
        "engine, never for a release - configure with -DRIFFSHEET_WITHOUT_BASIC_PITCH=ON.")
endfunction()

if(RIFFSHEET_WITHOUT_BASIC_PITCH)
    message(WARNING
        "Riffsheet: building WITHOUT ONNX Runtime. There is no built-in engine in this "
        "build, so a machine with no MuScriptor installed cannot transcribe anything. "
        "Do not ship this.")
    add_library(riffsheet_onnxruntime INTERFACE)
    add_library(riffsheet::onnxruntime ALIAS riffsheet_onnxruntime)
    target_compile_definitions(riffsheet_onnxruntime INTERFACE RIFFSHEET_HAS_ONNX=0)
    return()
endif()

# ---- Where it lives --------------------------------------------------------
# Same resolution order this project already uses for JUCE (shell/CMakeLists.txt
# lines 20-32): explicit -D first, then the environment, then nothing.
if(NOT DEFINED RIFFSHEET_ORT_DIR)
    if(DEFINED ENV{RIFFSHEET_ORT_DIR})
        set(RIFFSHEET_ORT_DIR "$ENV{RIFFSHEET_ORT_DIR}")
    elseif(DEFINED ENV{ORT_DIR})
        set(RIFFSHEET_ORT_DIR "$ENV{ORT_DIR}")
    endif()
endif()

if(NOT RIFFSHEET_ORT_DIR)
    _riffsheet_ort_not_found("no ONNX Runtime was given (-DRIFFSHEET_ORT_DIR is unset).")
endif()

get_filename_component(RIFFSHEET_ORT_DIR "${RIFFSHEET_ORT_DIR}" ABSOLUTE)

find_path(RIFFSHEET_ORT_INCLUDE_DIR
          NAMES onnxruntime_cxx_api.h
          HINTS "${RIFFSHEET_ORT_DIR}"
          PATH_SUFFIXES include include/onnxruntime
          NO_DEFAULT_PATH)

if(NOT RIFFSHEET_ORT_INCLUDE_DIR)
    _riffsheet_ort_not_found("there is no onnxruntime_cxx_api.h under ${RIFFSHEET_ORT_DIR}.")
endif()

if(MSVC)
    file(GLOB RIFFSHEET_ORT_LIBS "${RIFFSHEET_ORT_DIR}/lib/*.lib")
else()
    file(GLOB RIFFSHEET_ORT_LIBS "${RIFFSHEET_ORT_DIR}/lib/*.a")
endif()

if(NOT RIFFSHEET_ORT_LIBS)
    _riffsheet_ort_not_found("there are no static archives in ${RIFFSHEET_ORT_DIR}/lib.")
endif()

list(LENGTH RIFFSHEET_ORT_LIBS RIFFSHEET_ORT_LIB_COUNT)

# ---- macOS: the architectures have to actually be in there -----------------
# CI builds universal (.github/workflows/build.yml passes
# CMAKE_OSX_ARCHITECTURES="arm64;x86_64"), and a single-arch ORT against a
# universal build fails at LINK time with a message about missing symbols that
# says nothing about architectures. Say it here, where the answer fits.
if(APPLE AND CMAKE_OSX_ARCHITECTURES)
    list(GET RIFFSHEET_ORT_LIBS 0 _rs_ort_probe)
    execute_process(COMMAND lipo -archs "${_rs_ort_probe}"
                    OUTPUT_VARIABLE _rs_ort_archs
                    OUTPUT_STRIP_TRAILING_WHITESPACE
                    ERROR_QUIET)
    string(REPLACE " " ";" _rs_ort_arch_list "${_rs_ort_archs}")

    foreach(_rs_want IN LISTS CMAKE_OSX_ARCHITECTURES)
        if(NOT _rs_want IN_LIST _rs_ort_arch_list)
            message(FATAL_ERROR
                "Riffsheet: this build targets ${CMAKE_OSX_ARCHITECTURES} but the ONNX Runtime at "
                "${RIFFSHEET_ORT_DIR} is ${_rs_ort_archs} only, so ${_rs_want} has no runtime to "
                "link against.\n"
                "Build ORT once per architecture (--osx_arch arm64, then --osx_arch x86_64) and "
                "join the two with:\n"
                "    lipo -create <arm64>/lib/libonnxruntime.a <x86_64>/lib/libonnxruntime.a \\\n"
                "         -output <universal>/lib/libonnxruntime.a\n"
                "or build this one for a single architecture with -DCMAKE_OSX_ARCHITECTURES=${_rs_ort_arch_list}.")
        endif()
    endforeach()
    set(RIFFSHEET_ORT_ARCHS "${_rs_ort_archs}")
endif()

# ---- Did the CoreML execution provider get compiled in? --------------------
# OrtSession.cpp appends it behind RIFFSHEET_ORT_HAS_COREML. It is off in the
# shipping build (the CPU provider is already far faster than real time on this
# Mac - see BUILDING.md), and this test means turning it on is exactly
# "rebuild ORT --use_coreml" with no source change at all.
set(RIFFSHEET_ORT_HAS_COREML 0)
if(APPLE AND EXISTS "${RIFFSHEET_ORT_INCLUDE_DIR}/coreml_provider_factory.h")
    foreach(_rs_lib IN LISTS RIFFSHEET_ORT_LIBS)
        get_filename_component(_rs_name "${_rs_lib}" NAME)
        if(_rs_name MATCHES "coreml")
            set(RIFFSHEET_ORT_HAS_COREML 1)
        endif()
    endforeach()
endif()

# ---- The target ------------------------------------------------------------
add_library(riffsheet_onnxruntime INTERFACE)
add_library(riffsheet::onnxruntime ALIAS riffsheet_onnxruntime)

# SYSTEM, and this is load-bearing. juce_recommended_warning_flags is PUBLIC on
# the Riffsheet target, so without SYSTEM every ORT header is compiled under
# -Wall -Wextra -Wpedantic and the build drowns in warnings from code nobody
# here can fix.
target_include_directories(riffsheet_onnxruntime SYSTEM INTERFACE "${RIFFSHEET_ORT_INCLUDE_DIR}")

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # GNU ld resolves archives in command order and ORT's archives reference each
    # other in both directions. A link group makes it re-scan until it converges;
    # ld64 and link.exe already do that on their own.
    target_link_libraries(riffsheet_onnxruntime INTERFACE
        -Wl,--start-group ${RIFFSHEET_ORT_LIBS} -Wl,--end-group)
else()
    target_link_libraries(riffsheet_onnxruntime INTERFACE ${RIFFSHEET_ORT_LIBS})
endif()

find_package(Threads REQUIRED)
target_link_libraries(riffsheet_onnxruntime INTERFACE Threads::Threads)

if(APPLE)
    # onnxruntime_common uses NSProcessInfo for the CPU/OS query.
    target_link_libraries(riffsheet_onnxruntime INTERFACE "-framework Foundation")
    if(RIFFSHEET_ORT_HAS_COREML)
        target_link_libraries(riffsheet_onnxruntime INTERFACE "-framework CoreML")
    endif()
elseif(UNIX)
    target_link_libraries(riffsheet_onnxruntime INTERFACE ${CMAKE_DL_LIBS})
endif()

target_compile_definitions(riffsheet_onnxruntime INTERFACE
    RIFFSHEET_HAS_ONNX=1
    RIFFSHEET_ORT_HAS_COREML=${RIFFSHEET_ORT_HAS_COREML}
    RIFFSHEET_ORT_VERSION="${RIFFSHEET_ORT_VERSION}")

message(STATUS "Riffsheet: ONNX Runtime ${RIFFSHEET_ORT_VERSION} from ${RIFFSHEET_ORT_DIR} "
               "(${RIFFSHEET_ORT_LIB_COUNT} archives, CoreML EP: ${RIFFSHEET_ORT_HAS_COREML})")
