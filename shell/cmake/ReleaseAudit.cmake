# ---------------------------------------------------------------------------
# Release audit.                                       shell/cmake/ReleaseAudit.cmake
# ---------------------------------------------------------------------------
# Two questions that a release must be able to answer, asked by the build rather
# than by a document:
#
#   MODE=models   Is every byte under shell/Resources/models/ one we declared and
#                 have the right to ship?
#   MODE=sizes    Is the release still small enough to be worth downloading?
#
# WHY THE MODEL AUDIT EXISTS. Riffsheet is AGPL and some of the engines it can
# drive have non-commercial, gated weights that may never be redistributed
# (MuScriptor's, above all). EngineCatalog.cpp's static_assert already refuses to
# compile a manifest that would ship bytes it has no right to; this catches the
# other direction - bytes that are in the tree without any manifest row at all,
# because somebody dropped a 1.1 GB model.safetensors into Resources/ "just to
# test". Every file under Resources/models must appear in MANIFEST.sha256 with a
# matching digest, or the release build stops.
#
# WHY THE SIZE AUDIT EXISTS. juce_add_plugin links THREE products on macOS, so
# every embedded byte and every byte of statically linked ONNX Runtime is paid
# three times per release. The budget is a product decision: no single product
# zip over 35 MB, no release bundle over 100 MB. Blowing it should fail a build,
# not surprise a user on a slow connection.
#
# This file is both an includable module (it defines the target) and a script
# (cmake -P runs the checks). The script half is what CI calls after staging,
# where there is no configured build tree to hang a target off.

# ---------------------------------------------------------------------------
# Script mode
# ---------------------------------------------------------------------------
if(CMAKE_SCRIPT_MODE_FILE)

    # cmake -P starts with no policies set, and without CMP0057 `IN_LIST` is not
    # a known operator - which shows up as "Unknown arguments specified" rather
    # than as anything to do with policies. Everything below uses list(FIND)
    # instead, but this keeps the script honest about what it needs.
    cmake_minimum_required(VERSION 3.22)

    if(NOT DEFINED MODE)
        message(FATAL_ERROR "ReleaseAudit: pass -DMODE=models or -DMODE=sizes.")
    endif()

    # ---- MODE=models -------------------------------------------------------
    if(MODE STREQUAL "models")
        if(NOT DEFINED MODELS_DIR)
            message(FATAL_ERROR "ReleaseAudit: -DMODELS_DIR=<shell/Resources/models> is required.")
        endif()

        set(_manifest "${MODELS_DIR}/MANIFEST.sha256")

        if(NOT EXISTS "${MODELS_DIR}")
            message(STATUS "Riffsheet release audit: no models directory, nothing to audit.")
            return()
        endif()

        if(NOT EXISTS "${_manifest}")
            message(FATAL_ERROR
                "Riffsheet release audit: ${MODELS_DIR} exists but there is no MANIFEST.sha256 "
                "beside it. Every model Riffsheet ships must be declared with its digest. "
                "Create it with:  cd ${MODELS_DIR} && shasum -a 256 <relative-paths> > MANIFEST.sha256")
        endif()

        # Read the declarations: "<64 hex>  <relative path>", sha256sum format.
        file(STRINGS "${_manifest}" _lines)
        set(_declared "")
        set(_digests "")

        foreach(_line IN LISTS _lines)
            string(STRIP "${_line}" _line)

            if(_line STREQUAL "" OR _line MATCHES "^#")
                continue()
            endif()

            if(NOT _line MATCHES "^([0-9a-fA-F]+)[ \t]+\\*?(.+)$")
                message(FATAL_ERROR
                    "Riffsheet release audit: MANIFEST.sha256 line is not '<sha256>  <path>':\n  ${_line}")
            endif()

            string(TOLOWER "${CMAKE_MATCH_1}" _hash)
            set(_path "${CMAKE_MATCH_2}")
            string(LENGTH "${_hash}" _hashLen)

            if(NOT _hashLen EQUAL 64)
                message(FATAL_ERROR
                    "Riffsheet release audit: '${_path}' has a ${_hashLen}-character digest; "
                    "sha256 is 64. A truncated digest verifies nothing.")
            endif()

            # Two parallel lists rather than "path=hash" strings: a path is not a
            # regular expression and must not be matched as one.
            list(APPEND _declared "${_path}")
            list(APPEND _digests "${_hash}")
        endforeach()

        # Every file on disk must be declared, and match.
        file(GLOB_RECURSE _onDisk RELATIVE "${MODELS_DIR}" "${MODELS_DIR}/*")
        set(_checked 0)

        foreach(_file IN LISTS _onDisk)
            if(_file STREQUAL "MANIFEST.sha256")
                continue()
            endif()

            if(IS_DIRECTORY "${MODELS_DIR}/${_file}")
                continue()
            endif()

            list(FIND _declared "${_file}" _index)

            if(_index EQUAL -1)
                message(FATAL_ERROR
                    "Riffsheet release audit: '${_file}' is under Resources/models but is not in "
                    "MANIFEST.sha256, so nothing in this repository says what it is or whether it "
                    "may be redistributed. Declare it, or delete it. See "
                    "engine-architecture.md section 2.3.")
            endif()

            file(SHA256 "${MODELS_DIR}/${_file}" _actual)
            list(GET _digests ${_index} _want)

            if(NOT _actual STREQUAL _want)
                message(FATAL_ERROR
                    "Riffsheet release audit: '${_file}' does not match its declared digest.\n"
                    "  declared ${_want}\n"
                    "  on disk  ${_actual}\n"
                    "A model file changing without its manifest line changing is either a corrupt "
                    "checkout or a model somebody swapped. Neither ships.")
            endif()

            math(EXPR _checked "${_checked} + 1")
        endforeach()

        # And every declaration must have a file, so a deleted model cannot leave
        # a manifest line that looks like a promise.
        foreach(_path IN LISTS _declared)
            if(NOT EXISTS "${MODELS_DIR}/${_path}")
                message(FATAL_ERROR
                    "Riffsheet release audit: MANIFEST.sha256 declares '${_path}' but it is not "
                    "there. Remove the line or restore the file.")
            endif()
        endforeach()

        message(STATUS "Riffsheet release audit: ${_checked} model file(s) declared and verified.")
        return()
    endif()

    # ---- MODE=sizes --------------------------------------------------------
    # THE BUDGET. Per-product zip and whole-bundle ceilings, in bytes.
    if(MODE STREQUAL "sizes")
        if(NOT DEFINED STAGE_DIR)
            message(FATAL_ERROR "ReleaseAudit: -DSTAGE_DIR=<the staged release folder> is required.")
        endif()

        if(NOT DEFINED PRODUCT_MAX_MB)
            set(PRODUCT_MAX_MB 35)
        endif()

        if(NOT DEFINED BUNDLE_MAX_MB)
            set(BUNDLE_MAX_MB 100)
        endif()

        math(EXPR _productMax "${PRODUCT_MAX_MB} * 1048576")
        math(EXPR _bundleMax "${BUNDLE_MAX_MB} * 1048576")

        # Zip each product on its own so the number reported is the number a user
        # would download if the products were published separately, and so the
        # product that blew the budget is named rather than the release as a whole.
        file(GLOB _products "${STAGE_DIR}/*.vst3" "${STAGE_DIR}/*.component"
                            "${STAGE_DIR}/*.app" "${STAGE_DIR}/Riffsheet.exe"
                            "${STAGE_DIR}/Riffsheet")

        if(NOT _products)
            message(FATAL_ERROR
                "Riffsheet size audit: there are no products in ${STAGE_DIR}. Staging produced "
                "nothing, which is exactly the failure the staging step's hard-verify exists to "
                "catch - do not let it pass here either.")
        endif()

        get_filename_component(_stageParent "${STAGE_DIR}" DIRECTORY)
        set(_tmp "${_stageParent}/.size-audit")
        file(REMOVE_RECURSE "${_tmp}")
        file(MAKE_DIRECTORY "${_tmp}")

        set(_failures "")
        set(_report "")

        foreach(_product IN LISTS _products)
            get_filename_component(_name "${_product}" NAME)
            set(_zip "${_tmp}/${_name}.zip")

            execute_process(
                COMMAND "${CMAKE_COMMAND}" -E tar "cf" "${_zip}" --format=zip -- "${_name}"
                WORKING_DIRECTORY "${STAGE_DIR}"
                RESULT_VARIABLE _zipResult
                OUTPUT_QUIET ERROR_QUIET)

            if(NOT _zipResult EQUAL 0)
                message(FATAL_ERROR "Riffsheet size audit: could not zip ${_name}.")
            endif()

            file(SIZE "${_zip}" _bytes)
            math(EXPR _mb "(${_bytes} * 10 + 524288) / 1048576")
            math(EXPR _whole "${_mb} / 10")
            math(EXPR _tenth "${_mb} % 10")
            string(APPEND _report "    ${_whole}.${_tenth} MB  ${_name}\n")

            if(_bytes GREATER _productMax)
                list(APPEND _failures "${_name} zips to ${_whole}.${_tenth} MB, over the ${PRODUCT_MAX_MB} MB per-product budget")
            endif()
        endforeach()

        # The bundle: everything a release zip actually contains, zipped once.
        get_filename_component(_stageName "${STAGE_DIR}" NAME)
        set(_bundleZip "${_tmp}/bundle.zip")
        execute_process(
            COMMAND "${CMAKE_COMMAND}" -E tar "cf" "${_bundleZip}" --format=zip -- "${_stageName}"
            WORKING_DIRECTORY "${_stageParent}"
            RESULT_VARIABLE _zipResult
            OUTPUT_QUIET ERROR_QUIET)

        if(NOT _zipResult EQUAL 0)
            message(FATAL_ERROR "Riffsheet size audit: could not zip the staged bundle.")
        endif()

        file(SIZE "${_bundleZip}" _bundleBytes)
        math(EXPR _bmb "(${_bundleBytes} * 10 + 524288) / 1048576")
        math(EXPR _bwhole "${_bmb} / 10")
        math(EXPR _btenth "${_bmb} % 10")

        if(_bundleBytes GREATER _bundleMax)
            list(APPEND _failures "the release bundle zips to ${_bwhole}.${_btenth} MB, over the ${BUNDLE_MAX_MB} MB budget")
        endif()

        message(STATUS "Riffsheet size audit:\n${_report}    ${_bwhole}.${_btenth} MB  (whole bundle)")
        file(REMOVE_RECURSE "${_tmp}")

        if(_failures)
            string(REPLACE ";" "\n  - " _failureText "${_failures}")
            message(FATAL_ERROR
                "Riffsheet size audit FAILED:\n  - ${_failureText}\n"
                "The levers, cheapest first: build ONNX Runtime with "
                "--include_ops_by_config (an ops config generated from EVERY model this build "
                "ships, not just one) and --enable_reduced_operator_type_support; then "
                "--disable_rtti; then move any model over 1 MB out of juce_add_binary_data and "
                "into Contents/Resources/models, which stops it being paid three times. "
                "See BUILDING.md section 5.")
        endif()

        return()
    endif()

    message(FATAL_ERROR "ReleaseAudit: unknown MODE '${MODE}'.")
endif()

# ---------------------------------------------------------------------------
# Module mode: the target
# ---------------------------------------------------------------------------
# A plain target so it can be run on demand:
#     cmake --build shell/build --target riffsheet_release_audit
# and a dependency of Riffsheet when RIFFSHEET_RELEASE=ON, so a release build
# cannot be produced without it having passed.
add_custom_target(riffsheet_release_audit
    COMMAND ${CMAKE_COMMAND}
        -DMODE=models
        -DMODELS_DIR=${CMAKE_CURRENT_SOURCE_DIR}/Resources/models
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ReleaseAudit.cmake
    COMMENT "Auditing shell/Resources/models against MANIFEST.sha256"
    VERBATIM)
